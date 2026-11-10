import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { it } from "@effect/vitest";
import type { VoiceSessionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { expect } from "vite-plus/test";
import * as ElevenLabsVoice from "./ElevenLabsVoice.ts";
import {
  type VoiceSpeechConfig,
  VoiceSpeechProvider,
  type VoiceSynthesizerEvent,
  type VoiceTranscriberEvent,
} from "./VoiceSpeechProvider.ts";

const KEY = "xi-fixture-key-not-real";
const config: VoiceSpeechConfig = {
  apiKey: Redacted.make(KEY),
  voiceId: "VoiceFixture01",
  speechToTextModel: "scribe_v2_realtime",
  textToSpeechModel: "eleven_flash_v2_5",
  serverLocation: "global",
  zeroRetention: false,
};

interface Handshake {
  readonly url: string;
  readonly key: string | undefined;
  readonly traced: boolean;
}

/** A local stand-in for both ElevenLabs sockets. `script` decides what each one sends back. */
const withFakeElevenLabs = Effect.fn("test.withFakeElevenLabs")(function* (
  script: {
    readonly transcriber?: ReadonlyArray<unknown>;
    readonly synthesizer?: (message: Record<string, unknown>) => ReadonlyArray<unknown>;
  },
  run: (fake: {
    readonly baseUrl: string;
    readonly handshakes: Queue.Queue<Handshake>;
    readonly received: Queue.Queue<Record<string, unknown>>;
  }) => Effect.Effect<void, VoiceSessionError, VoiceSpeechProvider | Scope.Scope>,
) {
  const handshakes = yield* Queue.unbounded<Handshake>();
  const received = yield* Queue.unbounded<Record<string, unknown>>();
  const accept = (reply: (message: Record<string, unknown>) => ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* Queue.offer(handshakes, {
        url: request.url,
        key: request.headers["xi-api-key"],
        traced: "traceparent" in request.headers || "b3" in request.headers,
      });
      const socket = yield* request.upgrade;
      yield* Effect.gen(function* () {
        const writer = yield* socket.writer;
        const reader = yield* socket.reader;
        for (const message of reply({ opened: true })) yield* writer.write(JSON.stringify(message));
        while (true) {
          for (const frame of yield* reader.pull) {
            const message = JSON.parse(String(frame)) as Record<string, unknown>;
            yield* Queue.offer(received, message);
            for (const out of reply(message)) yield* writer.write(JSON.stringify(out));
          }
        }
      }).pipe(Effect.scoped, Effect.ignore);
      return HttpServerResponse.empty();
    });
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/v1/speech-to-text/realtime",
      accept((message) => (message.opened ? (script.transcriber ?? []) : [])),
    ),
    HttpRouter.add(
      "GET",
      "/v1/text-to-speech/:voiceId/multi-stream-input",
      accept((message) => (message.opened ? [] : (script.synthesizer?.(message) ?? []))),
    ),
  );
  yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
  const address = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
  const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
  const baseUrl = `ws://${host}:${address.port}`;
  return yield* run({ baseUrl, handshakes, received }).pipe(
    Effect.provide(
      ElevenLabsVoice.makeLayer({ baseUrl }).pipe(
        Layer.provide(NodeSocket.layerWebSocketConstructor),
      ),
    ),
  );
});

const connect = Effect.fn("test.elevenLabs.connect")(function* (
  overrides: Partial<VoiceSpeechConfig> = {},
) {
  const provider = yield* VoiceSpeechProvider;
  const heard = yield* Queue.unbounded<VoiceTranscriberEvent>();
  const spoken = yield* Queue.unbounded<VoiceSynthesizerEvent>();
  const connection = yield* provider.connect(
    { ...config, ...overrides },
    {
      onTranscriber: (event) => Queue.offer(heard, event),
      onSynthesizer: (event) => Queue.offer(spoken, event),
    },
  );
  return { ...connection, heard, spoken };
});

const live = <A, E>(effect: Effect.Effect<A, E, HttpServer.HttpServer | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));

it.live("sends the key only in the handshake header and translates both protocols", () => {
  const logs: string[] = [];
  const logger = Logger.make(({ message, cause }) => {
    logs.push(JSON.stringify([message, String(cause)]));
  });
  return live(
    withFakeElevenLabs(
      {
        transcriber: [
          { message_type: "session_started", session_id: "s1" },
          { message_type: "partial_transcript", text: "hello" },
          { message_type: "committed_transcript", text: "Hello there." },
        ],
        synthesizer: (message) =>
          message.flush === true
            ? [
                {
                  audio: Buffer.from([1, 2, 3, 4]).toString("base64"),
                  contextId: message.context_id,
                  alignment: {
                    chars: ["H", "i"],
                    charStartTimesMs: [0, 40],
                    charDurationsMs: [40, 40],
                  },
                },
              ]
            : message.close_context === true
              ? [{ isFinal: true, contextId: message.context_id }]
              : [],
      },
      (fake) =>
        Effect.gen(function* () {
          const voice = yield* connect();
          const handshakes = [
            yield* Queue.take(fake.handshakes),
            yield* Queue.take(fake.handshakes),
          ];
          const byPath = (path: string) => handshakes.find(({ url }) => url.startsWith(path))!;
          const stt = new URL(byPath("/v1/speech-to-text/realtime").url, fake.baseUrl);
          const tts = new URL(byPath("/v1/text-to-speech/VoiceFixture01/").url, fake.baseUrl);
          expect(handshakes.map(({ key, traced }) => [key, traced])).toEqual([
            [KEY, false],
            [KEY, false],
          ]);
          expect(Object.fromEntries(stt.searchParams)).toEqual({
            model_id: "scribe_v2_realtime",
            audio_format: "pcm_16000",
            commit_strategy: "vad",
            vad_silence_threshold_secs: "0.6",
          });
          expect(Object.fromEntries(tts.searchParams)).toEqual({
            model_id: "eleven_flash_v2_5",
            output_format: "pcm_24000",
            sync_alignment: "true",
            auto_mode: "true",
            inactivity_timeout: "180",
          });
          expect(yield* Queue.take(voice.heard)).toEqual({ type: "partial", text: "hello" });
          expect(yield* Queue.take(voice.heard)).toEqual({
            type: "committed",
            text: "Hello there.",
          });

          yield* voice.transcriber.send(new Uint8Array(new Float32Array([0.5, -1]).buffer));
          expect(yield* Queue.take(fake.received)).toEqual({
            message_type: "input_audio_chunk",
            audio_base_64: Buffer.from(new Int16Array([16384, -32768]).buffer).toString("base64"),
            commit: false,
            sample_rate: 16000,
          });

          yield* voice.synthesizer.speak("speech-1", "Hi");
          expect(yield* Queue.take(voice.spoken)).toEqual({
            type: "audio",
            contextId: "speech-1",
            pcm: Buffer.from([1, 2, 3, 4]),
            alignment: { chars: ["H", "i"], startMs: [0, 40] },
          });
          expect(yield* Queue.take(voice.spoken)).toEqual({ type: "done", contextId: "speech-1" });
          expect(yield* Queue.takeAll(fake.received)).toEqual([
            { text: "Hi ", context_id: "speech-1", flush: true },
            { context_id: "speech-1", close_context: true },
          ]);
          expect(JSON.stringify(handshakes.map(({ url }) => url))).not.toContain(KEY);
          expect(logs.join("\n")).not.toContain(KEY);
        }),
    ).pipe(Effect.provide(Logger.layer([logger]))),
  );
});

it.live("audio for a cancelled speech is dropped at the source", () =>
  live(
    withFakeElevenLabs(
      {
        transcriber: [{ message_type: "session_started" }],
        // A slow service: the audio for speech-1 only arrives after it was closed.
        synthesizer: (message) =>
          message.close_context === true
            ? [
                { audio: "AAAA", contextId: "speech-1" },
                { audio: "AQID", contextId: "speech-2" },
              ]
            : [],
      },
      () =>
        Effect.gen(function* () {
          const voice = yield* connect();
          yield* voice.synthesizer.cancel("speech-1");
          expect(yield* Queue.take(voice.spoken)).toMatchObject({ contextId: "speech-2" });
        }),
    ),
  ),
);

it.live.each([
  [{ message_type: "auth_error", error: "Invalid API key" }, {}, "rejected-key"],
  [{ message_type: "quota_exceeded", error: "Quota exceeded" }, {}, "rate-limit"],
  [{ message_type: "session_time_limit_exceeded", error: "Too long" }, {}, "unavailable"],
  // The user asked for nothing to be kept; a session that is kept anyway must not go on.
  [
    { message_type: "warning", warning: "zero retention not applied" },
    { zeroRetention: true },
    "zero-retention-unavailable",
  ],
] as const)("fails the conversation closed on %o", ([message, overrides, reason]) =>
  live(
    withFakeElevenLabs({ transcriber: [message] }, (fake) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(connect(overrides)).pipe(Effect.orDie);
        expect(error).toMatchObject({ _tag: "VoiceSessionError", reason });
        expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(KEY);
        if ("zeroRetention" in overrides) {
          const urls = [yield* Queue.take(fake.handshakes), yield* Queue.take(fake.handshakes)];
          expect(urls.every(({ url }) => url.includes("enable_logging=false"))).toBe(true);
        }
      }),
    ),
  ),
);
