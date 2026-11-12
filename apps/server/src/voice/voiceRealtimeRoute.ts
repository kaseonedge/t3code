import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  VOICE_REALTIME_PATH,
  VOICE_REALTIME_MAX_COMMAND_BYTES,
  VoiceRealtimeCommand,
  type VoiceRealtimeEvent,
  type ThreadId,
  VoiceSessionError,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { interactionModeRank, runtimeModeRank } from "../mcp/delegatedTaskModes.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";
import { mintElevenRealtimeSecret } from "./ElevenRealtimeSecret.ts";
import { spokenForm } from "./spokenForm.ts";
import { bindRealtimeVoiceWork, realtimeVoiceText } from "./VoiceRealtimeWork.ts";
import { bindVoiceThreadWork } from "./VoiceThreadWork.ts";

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceRealtimeCommand));
const encodeToolResult = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isVoiceSessionError = Schema.is(VoiceSessionError);
const unavailable = new VoiceSessionError({ reason: "unavailable" });
const MAX_OPERATIONS = 24;

export const voiceRealtimeRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const settings = yield* ServerSettings.ServerSettingsService;
    const resolver = yield* SecretResolver.SecretResolver;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const realtime = bindRealtimeVoiceWork(threads);
    const http = yield* HttpClient.HttpClient;
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
            const environmentId = yield* identity.getEnvironmentId;
            const resolve = Effect.fn("VoiceRealtime.resolve")(function* (threadId: ThreadId) {
              const shell = yield* realtime.find(threadId);
              if (shell === null)
                return yield* new VoiceSessionError({ reason: "router-unavailable" });
              return {
                target: { projectId: shell.projectId, threadId },
                link: formatThreadLink(
                  { environmentId, threadId },
                  realtimeVoiceText(shell.title, 120),
                ),
                title: realtimeVoiceText(shell.title, 120),
                runtimeMode: shell.runtimeMode,
                interactionMode: shell.interactionMode,
              };
            });
            const start = Effect.fn("VoiceRealtime.start")(function* (
              command: VoiceRealtimeCommand,
            ) {
              if (command.type !== "start") return yield* unavailable;
              const selected = yield* resolve(command.threadId);
              const { elevenLabs } = yield* settings.getSettings;
              if (elevenLabs.apiKey === "" || !elevenLabs.voiceId)
                return yield* new VoiceSessionError({ reason: "not-configured" });
              if (elevenLabs.zeroRetention || elevenLabs.serverLocation !== "global")
                return yield* new VoiceSessionError({ reason: "zero-retention-unavailable" });
              const key = yield* requireSettingsSecret(resolver, elevenLabs.apiKey).pipe(
                Effect.mapError(() => new VoiceSessionError({ reason: "unreadable-key" })),
              );
              const value = yield* mintElevenRealtimeSecret(
                Redacted.make(key),
                elevenLabs.voiceId,
                command.crossThread === true,
              ).pipe(Effect.provideService(HttpClient.HttpClient, http));
              yield* send({ type: "ready", value, threadId: command.threadId });
              yield* send({ type: "target", threadId: command.threadId, title: selected.title });
              return { ...selected, crossThread: command.crossThread === true };
            });
            let binding: Effect.Success<ReturnType<typeof start>> | undefined;
            const selectedChats = new Set<ThreadId>();
            const operations = new Set<string>();
            const fail = (operationId?: string, rejected = false) =>
              send({
                type: "error",
                ...(operationId === undefined ? {} : { operationId }),
                ...(rejected ? { reason: "operation-rejected" } : {}),
                message: "That voice action is unavailable in this conversation.",
              });
            while (true) {
              for (const frame of yield* reader.pull) {
                const command = yield* read(frame);
                if (command.type === "stop") return;
                if (binding === undefined) {
                  const started = yield* start(command).pipe(Effect.result);
                  if (started._tag === "Failure") {
                    yield* send({
                      type: "error",
                      message: isVoiceSessionError(started.failure)
                        ? started.failure.message
                        : unavailable.message,
                    });
                    return;
                  }
                  binding = started.success;
                  selectedChats.add(binding.target.threadId);
                  continue;
                }
                if (command.type === "start") return yield* unavailable;
                if (command.type === "select") {
                  const selected = yield* resolve(command.threadId).pipe(Effect.option);
                  if (
                    selected._tag === "None" ||
                    (selectedChats.size >= MAX_OPERATIONS && !selectedChats.has(command.threadId))
                  ) {
                    yield* fail();
                    continue;
                  }
                  binding = { ...binding, ...selected.value };
                  selectedChats.add(command.threadId);
                  yield* send({ type: "target", threadId: command.threadId, title: binding.title });
                  continue;
                }
                const { operationId } = command;
                const primary = binding.target.threadId;
                if (command.type === "transcript") {
                  if (!selectedChats.has(command.threadId) && !binding.crossThread) {
                    yield* fail(operationId);
                    continue;
                  }
                  yield* realtime
                    .record(command.threadId, operationId, command.role, command.text)
                    .pipe(
                      Effect.matchEffect({
                        onSuccess: () => send({ type: "transcript-saved", operationId }),
                        onFailure: () => fail(operationId),
                      }),
                    );
                  continue;
                }
                if (command.type === "discover" || command.type === "read") {
                  if (
                    !binding.crossThread &&
                    (command.type === "discover" || command.threadId !== primary)
                  ) {
                    yield* fail(operationId);
                    continue;
                  }
                  const data = yield* Effect.gen(function* () {
                    if (command.type === "discover")
                      return yield* realtime.discover(command.query ?? "");
                    return yield* realtime.read(command.threadId);
                  }).pipe(Effect.orElseSucceed(() => null));
                  if (data === null) yield* fail(operationId);
                  else
                    yield* send({
                      type: "tool-output",
                      operationId,
                      text: yield* encodeToolResult(data),
                    });
                  continue;
                }
                const threadId = command.threadId ?? primary;
                const originThreadId =
                  command.type === "submit" ? (command.originThreadId ?? primary) : primary;
                if (
                  !selectedChats.has(originThreadId) ||
                  (threadId !== originThreadId &&
                    !binding.crossThread &&
                    !(command.type === "recover" && selectedChats.has(threadId)))
                ) {
                  yield* fail(operationId, command.type === "submit");
                  continue;
                }
                const selected =
                  threadId === primary
                    ? binding
                    : yield* resolve(threadId).pipe(Effect.orElseSucceed(() => null));
                if (selected === null) {
                  yield* fail(operationId, command.type === "submit");
                  continue;
                }
                if (command.type === "submit" && threadId !== originThreadId) {
                  const allowed = yield* Effect.gen(function* () {
                    const origin = yield* resolve(originThreadId);
                    const destination = yield* resolve(threadId);
                    return (
                      runtimeModeRank(destination.runtimeMode) <=
                        runtimeModeRank(origin.runtimeMode) &&
                      interactionModeRank(destination.interactionMode) <=
                        interactionModeRank(origin.interactionMode)
                    );
                  }).pipe(Effect.orElseSucceed(() => false));
                  if (!allowed) {
                    yield* send({
                      type: "error",
                      operationId,
                      reason: "operation-rejected",
                      message:
                        "That chat requires broader permissions than the current voice chat.",
                    });
                    continue;
                  }
                }
                const { target, title, link } = selected;
                const work = bindVoiceThreadWork(threads, target);
                const operation = `${threadId}:${operationId}`;
                if (operations.size >= MAX_OPERATIONS && !operations.has(operation)) {
                  yield* fail(operationId, command.type === "submit");
                  continue;
                }
                if (
                  command.type === "submit" &&
                  (command.text.trim() === "" ||
                    realtimeVoiceText(command.text, 4000) === "[credential removed]")
                ) {
                  yield* fail(operationId, true);
                  continue;
                }
                const receipt = yield* Effect.gen(function* () {
                  if (command.type === "submit") {
                    const { runId, status, taskText } = yield* work.submit(
                      operationId,
                      command.text.trim(),
                      originThreadId,
                    );
                    return { runId, status, taskText, senderThreadId: originThreadId };
                  }
                  const operation = yield* work.recover(operationId);
                  if (operation === null) return "not-found" as const;
                  if (operation.runId === null) return null;
                  const status = yield* work.status(operation.runId);
                  return status === null
                    ? null
                    : {
                        ...status,
                        taskText: operation.taskText,
                        senderThreadId: operation.senderThreadId,
                      };
                }).pipe(Effect.orElseSucceed(() => null));
                if (receipt === "not-found") {
                  yield* send({
                    type: "error",
                    operationId,
                    reason: "operation-not-found",
                    message: "That task was not queued.",
                  });
                  continue;
                }
                if (receipt === null) {
                  yield* send({
                    type: "error",
                    operationId,
                    message: "T3 could not find or queue that task.",
                  });
                  continue;
                }
                yield* send({
                  type: "receipt",
                  operationId,
                  runId: receipt.runId,
                  status: receipt.status,
                  threadId,
                  link,
                });
                if (operations.has(operation)) continue;
                operations.add(operation);
                yield* Effect.gen(function* () {
                  const result = yield* threads.waitForThread({
                    ...target,
                    runId: receipt.runId,
                    untilDelegatedWorkSettled: true,
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
                    realtimeVoiceText(
                      messages.filter((message) => !message.streaming).at(-1)?.text ?? "",
                      4000,
                    ),
                  )
                    .join(" ")
                    .slice(0, 1200);
                  const taskLabel = spokenForm(realtimeVoiceText(receipt.taskText ?? "", 4000))
                    .join(" ")
                    .slice(0, 160);
                  const resultId = `voice-result:${run.id}`;
                  const origin = receipt.senderThreadId ?? target.threadId;
                  yield* realtime
                    .record(
                      origin,
                      resultId,
                      "assistant",
                      `T3 task “${taskLabel}” in ${link} ${run.status}. ${text}`,
                    )
                    .pipe(Effect.ignore);
                  yield* send({
                    type: "result",
                    operationId,
                    resultId,
                    sourceRunId: receipt.runId,
                    conversationThreadId: origin,
                    threadId: target.threadId,
                    threadTitle: title,
                    taskLabel,
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
