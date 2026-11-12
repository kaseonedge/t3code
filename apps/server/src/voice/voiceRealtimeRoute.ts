import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  VOICE_REALTIME_PATH,
  VOICE_REALTIME_MAX_COMMAND_BYTES,
  VoiceRealtimeCommand,
  type VoiceRealtimeEvent,
  VoiceSessionError,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";
import { mintElevenRealtimeSecret } from "./ElevenRealtimeSecret.ts";
import { spokenForm } from "./spokenForm.ts";
import { bindVoiceThreadWork } from "./VoiceThreadWork.ts";

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceRealtimeCommand));
const isVoiceSessionError = Schema.is(VoiceSessionError);
const unavailable = new VoiceSessionError({ reason: "unavailable" });
const MAX_OPERATIONS = 24;

export const voiceRealtimeRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const settings = yield* ServerSettings.ServerSettingsService;
    const resolver = yield* SecretResolver.SecretResolver;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    return HttpRouter.add(
      "GET",
      VOICE_REALTIME_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth
          .authenticateWebSocketUpgrade(request, "media")
          .pipe(Effect.result);
        if (session._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
        if (
          ![AuthOrchestrationOperateScope, AuthOrchestrationReadScope].every((scope) =>
            session.success.scopes.includes(scope),
          )
        )
          return HttpServerResponse.empty({ status: 403 });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            const socket = yield* request.upgrade;
            const reader = yield* socket.reader;
            const writer = yield* socket.writer;
            const send = (event: VoiceRealtimeEvent) =>
              writer.write(JSON.stringify(event)).pipe(Effect.ignore);
            const read = Effect.fnUntraced(function* (frame: unknown) {
              if (
                typeof frame !== "string" ||
                new TextEncoder().encode(frame).byteLength > VOICE_REALTIME_MAX_COMMAND_BYTES
              )
                return yield* unavailable;
              const command = decode(frame);
              return command._tag === "Some" ? command.value : yield* unavailable;
            });
            const start = Effect.fn("VoiceRealtime.start")(function* (
              command: VoiceRealtimeCommand,
            ) {
              if (command.type !== "start") return yield* unavailable;
              const { threadId } = command;
              const shell = yield* threads.getThreadShell(threadId);
              if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null)
                return yield* new VoiceSessionError({ reason: "no-router" });
              const { elevenLabs } = yield* settings.getSettings;
              if (elevenLabs.apiKey === "" || !elevenLabs.voiceId)
                return yield* new VoiceSessionError({ reason: "not-configured" });
              if (elevenLabs.zeroRetention || elevenLabs.serverLocation !== "global")
                return yield* new VoiceSessionError({ reason: "zero-retention-unavailable" });
              const key = yield* requireSettingsSecret(resolver, elevenLabs.apiKey);
              const value = yield* mintElevenRealtimeSecret(Redacted.make(key), elevenLabs.voiceId);
              const environmentId = yield* identity.getEnvironmentId;
              const target = { projectId: shell.projectId, threadId };
              const link = formatThreadLink({ environmentId, threadId }, shell.title);
              yield* send({ type: "ready", value, threadId });
              return { work: bindVoiceThreadWork(threads, target), target, link };
            });
            let binding: Effect.Success<ReturnType<typeof start>> | undefined;
            const operations = new Set<string>();
            while (true) {
              for (const frame of yield* reader.pull) {
                const command = yield* read(frame);
                if (command.type === "stop") return;
                if (binding === undefined) {
                  binding = yield* start(command);
                  continue;
                }
                if (command.type === "start") return yield* unavailable;
                const { operationId } = command;
                const { work, target, link } = binding;
                if (operations.size >= MAX_OPERATIONS && !operations.has(operationId)) {
                  yield* send({
                    type: "error",
                    operationId,
                    message: "This conversation reached its task limit.",
                  });
                  continue;
                }
                const receipt = yield* Effect.gen(function* () {
                  if (command.type === "submit") {
                    const { runId, status } = yield* work.submit(operationId, command.text);
                    return { runId, status };
                  }
                  const runId = yield* work.recover(operationId);
                  return runId === null ? null : yield* work.status(runId);
                }).pipe(Effect.orElseSucceed(() => null));
                if (receipt === null) {
                  yield* send({
                    type: "error",
                    operationId,
                    message: "T3 could not find or queue that task.",
                  });
                  continue;
                }
                yield* send({ type: "receipt", operationId, ...receipt, link });
                if (operations.has(operationId)) continue;
                operations.add(operationId);
                yield* Effect.gen(function* () {
                  const result = yield* threads.waitForThread({
                    ...target,
                    runId: receipt.runId,
                    timeoutMs: 300_000,
                  });
                  if (result.timedOut || result.run === null) return;
                  const run = result.resultRun ?? result.run;
                  const { messages } = yield* threads.getProjectThreadRecords(
                    target,
                    ["messages"],
                    { messageRunIds: [run.id], messageRoles: ["assistant"] },
                  );
                  const text = spokenForm(
                    messages.filter((message) => !message.streaming).at(-1)?.text ?? "",
                  ).join(" ");
                  yield* send({
                    type: "result",
                    operationId,
                    resultId: `voice-result:${run.id}`,
                    status: run.status,
                    text,
                    link,
                  });
                }).pipe(
                  Effect.catch(() =>
                    send({
                      type: "error",
                      operationId,
                      message: "T3 could not read that task's result.",
                    }),
                  ),
                  Effect.forkIn(scope),
                );
              }
            }
          }).pipe(
            Effect.timeout("310 seconds"),
            Effect.catch((error) => {
              // Provider or storage errors may contain request details.
              if (isVoiceSessionError(error))
                return Effect.logDebug("Realtime voice connection ended", { reason: error.reason });
              return Effect.void;
            }),
          ),
        );
        return HttpServerResponse.empty();
      }),
    );
  }),
);
