import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  VOICE_REALTIME_PATH,
  VoiceRealtimeEvent,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { expect } from "vite-plus/test";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { voiceRealtimeRouteLayer } from "./voiceRealtimeRoute.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceRealtimeEvent));
const primary = ThreadId.make("voice-primary");
const worker = ThreadId.make("voice-worker");
const privileged = ThreadId.make("privileged");
const projectId = ProjectId.make("voice-project");
const runId = RunId.make("run:thread:worker%3A1");
const privateText = "The password is hunter2.";
const shell = (id: ThreadId) =>
  ({
    id,
    projectId,
    title: id,
    archivedAt: null,
    deletedAt: null,
    lineage: {},
    interactionMode: "default",
    runtimeMode: id === privileged ? "full-access" : "approval-required",
  }) as never;

function connection(url: string) {
  const socket = new WebSocket(url);
  const received: Array<VoiceRealtimeEvent> = [];
  let waiting: ReturnType<typeof Promise.withResolvers<VoiceRealtimeEvent>> | undefined;
  socket.addEventListener("message", ({ data }) => {
    const frame = decode(data);
    if (waiting) {
      waiting.resolve(frame);
      waiting = undefined;
    } else received.push(frame);
  });
  return {
    socket,
    opened: new Promise((resolve) => socket.addEventListener("open", resolve)),
    closed: new Promise((resolve) => socket.addEventListener("close", resolve)),
    send: (command: object) => socket.send(JSON.stringify(command)),
    next: () => {
      const next = received.shift();
      if (next) return Promise.resolve(next);
      waiting = Promise.withResolvers();
      return waiting.promise;
    },
  };
}

it.live(
  "queues authorized cross-chat work, returns a receipt, and recovers the attributed result",
  () => {
    const finish = Promise.withResolvers<void>();
    const tasks = new Map<
      string,
      { id: MessageId; runId: RunId; text: string; senderThreadId?: ThreadId }
    >();
    const recorded = new Map<string, { threadId: ThreadId; text: string }>();
    const routes = voiceRealtimeRouteLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateWebSocketUpgrade: () =>
              Effect.succeed({
                sessionId: AuthSessionId.make("voice-session"),
                subject: "fixture",
                method: "browser-session-cookie",
                scopes: AuthStandardClientScopes,
              }),
          }),
          Layer.mock(SecretResolver.SecretResolver)({}),
          Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("voice-fixture")),
          }),
          ServerSettings.layerTest({
            elevenLabs: { apiKey: "fixture-key", voiceId: "VoiceFixture01" },
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({ value: "fixture-ephemeral" })),
              ),
            ),
          ),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed(
                id === primary || id === worker || id === privileged ? shell(id) : null,
              ),
            listProjectThreads: () => Effect.succeed([shell(primary), shell(worker)]),
            getThreadSnapshotWindow: () =>
              Effect.succeed({
                projection: {
                  messages: [{ role: "assistant", streaming: false, text: privateText }],
                },
              } as never),
            sendToThread: (input) =>
              Effect.sync(() => {
                const message = {
                  id: input.messageId,
                  text: input.text,
                  runId,
                  ...(input.senderThreadId === undefined
                    ? {}
                    : { senderThreadId: input.senderThreadId }),
                };
                tasks.set(message.id, message);
                return { message, run: { id: runId, status: "queued" } } as never;
              }),
            getProjectThreadRecords: (_, fields, filter) =>
              Effect.sync(() => {
                const task = filter?.messageIds?.map((id) => tasks.get(id)).filter(Boolean) ?? [];
                return (
                  fields.includes("runs" as never)
                    ? { runs: [{ id: runId, status: "completed" }] }
                    : {
                        messages: filter?.messageIds
                          ? task
                          : [{ streaming: false, text: "Build passed." }],
                      }
                ) as never;
              }),
            waitForThread: () =>
              Effect.promise(async () => {
                await finish.promise;
                return { timedOut: false, run: { id: runId, status: "completed" } } as never;
              }),
            getThreadRecords: (_, __, filter) =>
              Effect.sync(
                () =>
                  ({
                    messages: (filter?.messageIds ?? [])
                      .filter((id) => recorded.has(id))
                      .map((id) => ({ id })),
                  }) as never,
              ),
            dispatch: (command) =>
              Effect.sync(() => {
                if (command.type === "voice.transcript.record") {
                  recorded.set(command.messageId, {
                    threadId: command.threadId,
                    text: command.text,
                  });
                }
                return { sequence: 1 } as never;
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
      const { port } = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
      const url = `ws://127.0.0.1:${port}${VOICE_REALTIME_PATH}`;
      yield* Effect.promise(async () => {
        const single = connection(url);
        await single.opened;
        single.send({ type: "start", threadId: primary });
        expect(await single.next()).toEqual({
          type: "ready",
          threadId: primary,
          value: "fixture-ephemeral",
        });
        expect(await single.next()).toMatchObject({ type: "target", threadId: primary });
        single.send({ type: "discover", operationId: "denied" });
        expect(await single.next()).toMatchObject({ type: "error", operationId: "denied" });
        single.send({
          type: "submit",
          operationId: "denied-work",
          threadId: worker,
          text: "Check the build",
        });
        expect(await single.next()).toMatchObject({ type: "error", operationId: "denied-work" });
        expect(tasks.size).toBe(0);
        single.socket.close();
        await single.closed;

        const central = connection(url);
        await central.opened;
        central.send({ type: "start", threadId: primary, crossThread: true });
        expect(await central.next()).toMatchObject({ type: "ready" });
        expect(await central.next()).toMatchObject({ type: "target", threadId: primary });
        central.send({
          type: "submit",
          operationId: "privileged-work",
          threadId: privileged,
          text: "Check the build",
        });
        expect(await central.next()).toMatchObject({
          type: "error",
          message: expect.stringContaining("broader permissions"),
        });
        expect(tasks.size).toBe(0);
        central.send({ type: "discover", operationId: "discover", query: "worker" });
        expect(await central.next()).toMatchObject({
          type: "tool-output",
          text: expect.stringContaining(worker),
        });
        central.send({ type: "read", operationId: "read", threadId: worker });
        expect(await central.next()).toMatchObject({
          type: "tool-output",
          text: expect.stringContaining("[credential removed]"),
        });
        const utterance = {
          type: "transcript",
          operationId: "voice-turn",
          threadId: primary,
          role: "user",
          text: "Check the build.",
        };
        for (const command of [utterance, utterance]) {
          central.send(command);
          expect(await central.next()).toMatchObject({
            type: "transcript-saved",
            operationId: "voice-turn",
          });
        }
        expect(recorded.size).toBe(1);
        central.send({
          type: "submit",
          operationId: "accepted",
          threadId: worker,
          text: "Check the build",
        });
        expect(await central.next()).toMatchObject({
          type: "receipt",
          status: "queued",
          threadId: worker,
        });
        central.send({ type: "select", threadId: worker });
        expect(await central.next()).toMatchObject({ type: "target", threadId: worker });
        central.socket.close();
        await central.closed;

        const resumed = connection(url);
        await resumed.opened;
        resumed.send({ type: "start", threadId: worker, crossThread: true });
        expect(await resumed.next()).toMatchObject({ type: "ready" });
        expect(await resumed.next()).toMatchObject({ type: "target", threadId: worker });
        resumed.send({ type: "recover", operationId: "accepted", threadId: worker });
        expect(await resumed.next()).toMatchObject({ type: "receipt", runId });
        finish.resolve();
        expect(await resumed.next()).toMatchObject({
          type: "result",
          threadId: worker,
          conversationThreadId: primary,
          sourceRunId: runId,
          taskLabel: "Check the build",
          text: "Build passed.",
        });
        expect([...recorded.values()]).toContainEqual({
          threadId: primary,
          text: expect.stringContaining("Build passed."),
        });
        expect(tasks.size).toBe(1);
        resumed.send({ type: "stop" });
        await resumed.closed;
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest));
  },
);
