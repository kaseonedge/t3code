import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it } from "@effect/vitest";
import { ThreadId, VoiceSessionError, VoiceSessionEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { expect } from "vite-plus/test";
import type { VoiceSessionService } from "./VoiceSessionService.ts";
import { runVoiceSessionSocket } from "./voiceSessionRoute.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceSessionEvent));

function client(url: string) {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const frames: Array<VoiceSessionEvent | Uint8Array> = [];
  let waiter: ReturnType<typeof Promise.withResolvers<VoiceSessionEvent | Uint8Array>> | undefined;
  socket.addEventListener("message", ({ data }) => {
    const frame = typeof data === "string" ? decodeEvent(data) : new Uint8Array(data);
    if (waiter) {
      waiter.resolve(frame);
      waiter = undefined;
    } else frames.push(frame);
  });
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", ({ code }) => resolve(code)),
  );
  return {
    socket,
    closed,
    opened: new Promise((resolve) => socket.addEventListener("open", resolve)),
    next: () => {
      const frame = frames.shift();
      if (frame) return Promise.resolve(frame);
      waiter = Promise.withResolvers();
      return waiter.promise;
    },
  };
}

const withServer = Effect.fn("test.voiceRoute.withServer")(function* (
  open: VoiceSessionService["Service"]["open"],
  run: (url: string) => Promise<void>,
) {
  const routes = HttpRouter.add(
    "GET",
    "/ws/voice-session",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* request.upgrade;
      yield* runVoiceSessionSocket(socket, { open }).pipe(Effect.scoped);
      return HttpServerResponse.empty();
    }),
  );
  yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
  const address = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
  const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
  yield* Effect.promise(() => run(`ws://${host}:${address.port}/ws/voice-session`));
});

const router = ThreadId.make("voice-router");

it.live("carries audio both ways, reports cleared playback, and ends on stop", () => {
  const fed: number[] = [];
  const cleared: Array<[number, number]> = [];
  const released = Promise.withResolvers<void>();
  return withServer(
    (io) =>
      Effect.acquireRelease(
        Effect.succeed({
          routerThreadId: router,
          feedAudio: (pcm: Uint8Array) =>
            Effect.sync(() => void fed.push(pcm.byteLength)).pipe(
              Effect.andThen(io.sendAudio(new Uint8Array([7, 0, 0, 0, 1, 2]))),
            ),
          cleared: (speechId: number, playedMs: number) =>
            Effect.sync(() => void cleared.push([speechId, playedMs])).pipe(
              Effect.andThen(io.send({ type: "clear", speechId })),
            ),
          say: () => Effect.die("unused"),
          status: Effect.die("unused"),
          failed: Effect.never,
        }),
        () => Effect.sync(() => released.resolve()),
      ),
    async (url) => {
      const connection = client(url);
      await connection.opened;
      connection.socket.send(JSON.stringify({ type: "start" }));
      expect(await connection.next()).toEqual({ type: "ready", routerThreadId: router });
      connection.socket.send(new Float32Array([0.25, 0.5]));
      expect(await connection.next()).toEqual(new Uint8Array([7, 0, 0, 0, 1, 2]));
      connection.socket.send(JSON.stringify({ type: "cleared", speechId: 7, playedMs: 120 }));
      expect(await connection.next()).toEqual({ type: "clear", speechId: 7 });
      connection.socket.send(JSON.stringify({ type: "stop" }));
      expect(await connection.next()).toEqual({ type: "ended" });
      expect(await connection.closed).toBe(1000);
      await released.promise;
      expect(fed).toEqual([8]);
      expect(cleared).toEqual([[7, 120]]);
    },
  ).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});

it.live("tells the client why a conversation could not start or had to stop", () => {
  const broken = Promise.withResolvers<"rate-limit">();
  let attempts = 0;
  return withServer(
    () =>
      ++attempts === 1
        ? Effect.fail(new VoiceSessionError({ reason: "unreadable-key" }))
        : Effect.succeed({
            routerThreadId: router,
            feedAudio: () => Effect.void,
            cleared: () => Effect.void,
            say: () => Effect.die("unused"),
            status: Effect.die("unused"),
            failed: Effect.promise(() => broken.promise),
          }),
    async (url) => {
      const refused = client(url);
      await refused.opened;
      // Audio before `start` is a protocol error, not something to forward anywhere.
      refused.socket.send(JSON.stringify({ type: "start" }));
      expect(await refused.next()).toMatchObject({ type: "error", reason: "unreadable-key" });
      expect(await refused.closed).toBe(1008);

      const running = client(url);
      await running.opened;
      running.socket.send(JSON.stringify({ type: "start" }));
      expect(await running.next()).toMatchObject({ type: "ready" });
      broken.resolve("rate-limit");
      expect(await running.next()).toMatchObject({ type: "error", reason: "rate-limit" });
      expect(await running.closed).toBe(1008);

      const early = client(url);
      await early.opened;
      early.socket.send(new Float32Array([0.25]));
      expect(await early.next()).toMatchObject({ type: "error", reason: "unavailable" });
    },
  ).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
});
