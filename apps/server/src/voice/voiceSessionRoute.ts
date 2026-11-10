import {
  AuthOrchestrationOperateScope,
  VOICE_SESSION_MAX_CHUNK_BYTES,
  VOICE_SESSION_MAX_COMMAND_BYTES,
  VOICE_SESSION_PATH,
  VoiceSessionCommand,
  VoiceSessionError,
  type VoiceSessionEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type { VoiceSession } from "./VoiceSession.ts";
import * as VoiceSessionService from "./VoiceSessionService.ts";

const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(VoiceSessionCommand));

/** One socket is one conversation. It ends with the socket, a `stop`, or a speech failure. */
export const runVoiceSessionSocket = Effect.fn("voice.runSessionSocket")(function* (
  socket: Socket.Socket,
  voice: Pick<VoiceSessionService.VoiceSessionService["Service"], "open">,
) {
  const scope = yield* Scope.Scope;
  const writer = yield* socket.writer;
  const send = (event: VoiceSessionEvent) =>
    writer.write(JSON.stringify(event)).pipe(Effect.ignore);
  const end = Effect.fn("voice.endSessionSocket")(function* (error: VoiceSessionError | undefined) {
    yield* send(
      error === undefined
        ? { type: "ended" }
        : { type: "error", reason: error.reason, message: error.message },
    );
    yield* writer
      .write(new Socket.CloseEvent(error === undefined ? 1000 : 1008))
      .pipe(Effect.ignore);
  });
  const invalid = Effect.fail(new VoiceSessionError({ reason: "unavailable" }));
  let session: VoiceSession | undefined;
  const started = yield* Deferred.make<VoiceSession>();
  const receive = Effect.fnUntraced(function* (frame: string | Uint8Array) {
    if (typeof frame !== "string") {
      if (session === undefined || frame.byteLength > VOICE_SESSION_MAX_CHUNK_BYTES)
        return yield* invalid;
      yield* session.feedAudio(frame);
      return false;
    }
    if (new TextEncoder().encode(frame).byteLength > VOICE_SESSION_MAX_COMMAND_BYTES)
      return yield* invalid;
    const command = yield* decodeCommand(frame).pipe(Effect.catch(() => invalid));
    if (command.type === "stop") return true;
    if (command.type === "start") {
      if (session !== undefined) return yield* invalid;
      const opened = yield* voice
        .open({ send, sendAudio: (audio) => writer.write(audio).pipe(Effect.ignore) })
        .pipe(Scope.provide(scope));
      session = opened;
      yield* Deferred.succeed(started, opened);
      yield* send({ type: "ready", routerThreadId: opened.routerThreadId });
      return false;
    }
    if (session === undefined) return yield* invalid;
    yield* session.cleared(command.speechId, command.playedMs);
    return false;
  });
  const reader = yield* socket.reader;
  const frames = Effect.gen(function* () {
    while (true) {
      for (const frame of yield* reader.pull) {
        if (yield* receive(frame)) return;
      }
    }
  });
  const watch = Deferred.await(started).pipe(
    Effect.flatMap((opened) => opened.failed),
    Effect.flatMap((reason) => Effect.fail(new VoiceSessionError({ reason }))),
  );
  yield* Effect.raceFirst(frames, watch).pipe(
    Effect.matchEffect({
      onSuccess: () => end(undefined),
      onFailure: (error) =>
        error._tag === "VoiceSessionError"
          ? end(error)
          : // The socket closed under us; there is nobody left to tell.
            Effect.void,
    }),
  );
});

export const voiceSessionRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const voice = yield* VoiceSessionService.VoiceSessionService;
    return HttpRouter.add(
      "GET",
      VOICE_SESSION_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth
          .authenticateWebSocketUpgrade(request, "media")
          .pipe(Effect.result);
        if (session._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
        if (!session.success.scopes.includes(AuthOrchestrationOperateScope))
          return HttpServerResponse.empty({ status: 403 });
        const socket = yield* request.upgrade;
        yield* runVoiceSessionSocket(socket, voice).pipe(Effect.scoped);
        return HttpServerResponse.empty();
      }),
    );
  }),
);
