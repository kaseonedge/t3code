import {
  type ElevenLabsServerLocation,
  VOICE_SESSION_INPUT_SAMPLE_RATE,
  VOICE_SESSION_OUTPUT_SAMPLE_RATE,
  VoiceSessionError,
  type VoiceSessionErrorReason,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { upstreamWebSocketConstructor } from "../device/DeviceHubProxy.ts";
import {
  type VoiceSpeechConfig,
  VoiceSpeechProvider,
  type VoiceSpeechSinks,
  type VoiceSynthesizer,
  type VoiceTranscriber,
} from "./VoiceSpeechProvider.ts";

// A closed map, never a setting: the API key is only ever sent to one of these hosts.
const HOSTS: Record<ElevenLabsServerLocation, string> = {
  global: "wss://api.elevenlabs.io",
  us: "wss://api.us.elevenlabs.io",
  eu: "wss://api.eu.residency.elevenlabs.io",
  in: "wss://api.in.residency.elevenlabs.io",
};

/** Silence after speech that ends the user's turn. */
const TURN_SILENCE_SECONDS = 0.6;
const OPEN_TIMEOUT = "10 seconds";

const TranscriberMessage = Schema.fromJsonString(
  Schema.Struct({
    message_type: Schema.String,
    text: Schema.optional(Schema.String),
  }),
);
const decodeTranscriberMessage = Schema.decodeUnknownOption(TranscriberMessage);

const Alignment = Schema.Struct({
  chars: Schema.Array(Schema.String),
  charStartTimesMs: Schema.Array(Schema.Finite),
});
const SynthesizerMessage = Schema.fromJsonString(
  Schema.Struct({
    audio: Schema.optional(Schema.NullOr(Schema.String)),
    contextId: Schema.optional(Schema.String),
    context_id: Schema.optional(Schema.String),
    isFinal: Schema.optional(Schema.NullOr(Schema.Boolean)),
    is_final: Schema.optional(Schema.NullOr(Schema.Boolean)),
    alignment: Schema.optional(Schema.NullOr(Alignment)),
    error: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
);
const decodeSynthesizerMessage = Schema.decodeUnknownOption(SynthesizerMessage);

const TRANSCRIPT_MESSAGES = new Set([
  "session_started",
  "committed_transcript_with_timestamps",
  "committed_transcript_entities",
  "redacted_transcript",
  "edited_transcript",
]);

/** ElevenLabs names the failure in `message_type` or in free text; neither carries the key. */
function elevenLabsFailureReason(detail: string): VoiceSessionErrorReason {
  const text = detail.toLowerCase();
  if (/auth|unauthori[sz]ed|invalid_api_key|unaccepted_terms/.test(text)) return "rejected-key";
  if (/quota|rate_limit|throttl|resource_exhausted|queue_overflow|too_many_concurrent/.test(text))
    return "rate-limit";
  return "unavailable";
}

function float32ToPcm16Base64(pcm: Uint8Array): string {
  const samples = Math.floor(pcm.byteLength / 4);
  const input = new DataView(pcm.buffer, pcm.byteOffset, samples * 4);
  const output = Buffer.allocUnsafe(samples * 2);
  for (let index = 0; index < samples; index++) {
    const sample = Math.max(-1, Math.min(1, input.getFloat32(index * 4, true) || 0));
    output.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), index * 2);
  }
  return output.toString("base64");
}

interface Connection {
  readonly pull: Socket.Reader["pull"];
  readonly write: (message: unknown) => Effect.Effect<void>;
}

/**
 * The key travels only in the handshake header. A WebSocket handshake never follows a redirect,
 * and no trace context is attached, so nothing else learns the key or the request.
 */
const open = Effect.fn("ElevenLabsVoice.open")(function* (
  url: URL,
  apiKey: Redacted.Redacted<string>,
) {
  const socket = yield* Socket.makeWebSocket(url.toString(), {
    openTimeout: OPEN_TIMEOUT,
    headers: { "xi-api-key": Redacted.value(apiKey) },
  });
  const writer = yield* socket.writer;
  // Acquiring the reader opens the connection, so a refused handshake fails the conversation here.
  const reader = yield* socket.reader.pipe(
    Effect.mapError(() => new VoiceSessionError({ reason: "unavailable" })),
  );
  return {
    pull: reader.pull,
    write: (message) => writer.write(JSON.stringify(message)).pipe(Effect.ignore),
  } satisfies Connection;
});

const connectTranscriber = Effect.fn("ElevenLabsVoice.connectTranscriber")(function* (
  baseUrl: string,
  config: VoiceSpeechConfig,
  emit: VoiceSpeechSinks["onTranscriber"],
) {
  const scope = yield* Scope.Scope;
  const url = new URL("/v1/speech-to-text/realtime", baseUrl);
  url.searchParams.set("model_id", config.speechToTextModel);
  url.searchParams.set("audio_format", `pcm_${VOICE_SESSION_INPUT_SAMPLE_RATE}`);
  url.searchParams.set("commit_strategy", "vad");
  url.searchParams.set("vad_silence_threshold_secs", String(TURN_SILENCE_SECONDS));
  if (config.zeroRetention) url.searchParams.set("enable_logging", "false");
  const connection = yield* open(url, config.apiKey);
  const started = yield* Deferred.make<void, VoiceSessionError>();
  const fail = (reason: VoiceSessionErrorReason) =>
    Deferred.fail(started, new VoiceSessionError({ reason })).pipe(
      Effect.andThen(emit({ type: "failed", reason })),
    );
  // Runs for every frame of a long conversation; a span each would only add noise.
  const receive = Effect.fnUntraced(function* (frame: string | Uint8Array) {
    if (typeof frame !== "string") return;
    const decoded = decodeTranscriberMessage(frame);
    if (decoded._tag === "None") return;
    const { message_type: type, text = "" } = decoded.value;
    if (type === "session_started") return yield* Deferred.succeed(started, undefined);
    if (type === "partial_transcript") return yield* emit({ type: "partial", text });
    if (type === "committed_transcript") return yield* emit({ type: "committed", text });
    if (TRANSCRIPT_MESSAGES.has(type)) return;
    // The user asked for nothing to be kept and ElevenLabs is keeping it: stop, do not continue.
    if (type === "warning") {
      if (config.zeroRetention) yield* fail("zero-retention-unavailable");
      return;
    }
    yield* fail(elevenLabsFailureReason(type));
  });
  yield* Effect.forever(
    connection.pull.pipe(
      Effect.flatMap((frames) => Effect.forEach(frames, receive, { discard: true })),
    ),
  ).pipe(
    Effect.catch(() => fail("unavailable")),
    Effect.forkIn(scope),
  );
  yield* Deferred.await(started).pipe(
    Effect.timeoutOrElse({
      duration: OPEN_TIMEOUT,
      orElse: () => Effect.fail(new VoiceSessionError({ reason: "unavailable" })),
    }),
  );
  return {
    send: (pcm) =>
      connection.write({
        message_type: "input_audio_chunk",
        audio_base_64: float32ToPcm16Base64(pcm),
        commit: false,
        sample_rate: VOICE_SESSION_INPUT_SAMPLE_RATE,
      }),
  } satisfies VoiceTranscriber;
});

const connectSynthesizer = Effect.fn("ElevenLabsVoice.connectSynthesizer")(function* (
  baseUrl: string,
  config: VoiceSpeechConfig,
  emit: VoiceSpeechSinks["onSynthesizer"],
) {
  const scope = yield* Scope.Scope;
  const url = new URL(
    `/v1/text-to-speech/${encodeURIComponent(config.voiceId)}/multi-stream-input`,
    baseUrl,
  );
  url.searchParams.set("model_id", config.textToSpeechModel);
  url.searchParams.set("output_format", `pcm_${VOICE_SESSION_OUTPUT_SAMPLE_RATE}`);
  url.searchParams.set("sync_alignment", "true");
  // Whole sentences arrive at once, so the service need not wait to buffer more text.
  url.searchParams.set("auto_mode", "true");
  url.searchParams.set("inactivity_timeout", "180");
  if (config.zeroRetention) url.searchParams.set("enable_logging", "false");
  const connection = yield* open(url, config.apiKey);
  const cancelled = new Set<string>();
  // Runs for every audio chunk; a span each would only add noise.
  const receive = Effect.fnUntraced(function* (frame: string | Uint8Array) {
    if (typeof frame !== "string") return;
    const decoded = decodeSynthesizerMessage(frame);
    if (decoded._tag === "None") return;
    const message = decoded.value;
    const contextId = message.contextId ?? message.context_id;
    if (contextId === undefined) {
      const detail = message.error ?? message.message;
      if (detail !== undefined)
        yield* emit({ type: "failed", reason: elevenLabsFailureReason(detail) });
      return;
    }
    if (cancelled.has(contextId)) return;
    if (message.audio) {
      yield* emit({
        type: "audio",
        contextId,
        pcm: Buffer.from(message.audio, "base64"),
        alignment: message.alignment
          ? { chars: message.alignment.chars, startMs: message.alignment.charStartTimesMs }
          : undefined,
      });
    }
    if (message.isFinal || message.is_final) yield* emit({ type: "done", contextId });
  });
  yield* Effect.forever(
    connection.pull.pipe(
      Effect.flatMap((frames) => Effect.forEach(frames, receive, { discard: true })),
    ),
  ).pipe(
    Effect.catch(() => emit({ type: "failed", reason: "unavailable" })),
    Effect.forkIn(scope),
  );
  yield* Effect.addFinalizer(() => connection.write({ close_socket: true }));
  return {
    speak: (contextId, text) =>
      connection
        .write({ text: `${text} `, context_id: contextId, flush: true })
        .pipe(Effect.andThen(connection.write({ context_id: contextId, close_context: true }))),
    cancel: (contextId) =>
      Effect.sync(() => cancelled.add(contextId)).pipe(
        Effect.andThen(connection.write({ context_id: contextId, close_context: true })),
      ),
  } satisfies VoiceSynthesizer;
});

/**
 * Eleven v3 and v4 models are not served by the multi-context socket above. They speak only
 * through the single-stream "Text to Dialogue" socket, which has no contexts, so nothing but
 * closing the connection stops a sentence. Each thing the bot says therefore gets its own
 * connection: barge-in closes it, and its closing flush marks the end of the speech.
 */
const usesDialogueSocket = (model: string) => /^eleven_v[34]/.test(model);

const DialogueMessage = Schema.fromJsonString(
  Schema.Struct({
    audio: Schema.optional(Schema.NullOr(Schema.String)),
    alignment: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          chars: Schema.Array(Schema.String),
          char_start_times_ms: Schema.Array(Schema.Finite),
        }),
      ),
    ),
    is_final: Schema.optional(Schema.NullOr(Schema.Boolean)),
    error: Schema.optional(Schema.String),
  }),
);
const decodeDialogueMessage = Schema.decodeUnknownOption(DialogueMessage);

const connectDialogueSynthesizer = Effect.fn("ElevenLabsVoice.connectDialogueSynthesizer")(
  function* (baseUrl: string, config: VoiceSpeechConfig, emit: VoiceSpeechSinks["onSynthesizer"]) {
    const scope = yield* Scope.Scope;
    const constructor = yield* Socket.WebSocketConstructor;
    const url = new URL("/v1/text-to-dialogue/stream-input", baseUrl);
    url.searchParams.set("model_id", config.textToSpeechModel);
    url.searchParams.set("output_format", `pcm_${VOICE_SESSION_OUTPUT_SAMPLE_RATE}`);
    url.searchParams.set("sync_alignment", "true");
    if (config.zeroRetention) url.searchParams.set("enable_logging", "false");
    const speeches = new Map<string, Scope.Closeable>();
    const cancelled = new Set<string>();
    // A cancelled speech says nothing more, not even that its socket closed.
    const report = (contextId: string, event: Parameters<typeof emit>[0]) =>
      Effect.suspend(() => (cancelled.has(contextId) ? Effect.void : emit(event)));

    const run = Effect.fn("ElevenLabsVoice.speakDialogue")(function* (
      contextId: string,
      text: string,
    ) {
      const connection = yield* open(url, config.apiKey);
      yield* connection.write({ voices: [config.voiceId] });
      yield* connection.write({
        inputs: [{ text, voice_id: config.voiceId, new_turn: true }],
      });
      // Flushes the text however short it is, sends the last audio, then `is_final`.
      yield* connection.write({ close_socket: true });
      let heard = false;
      while (true) {
        const frames = yield* connection.pull.pipe(Effect.option);
        // The socket closed. With audio already played that is an ending; without, a failure.
        if (frames._tag === "None")
          return yield* report(
            contextId,
            heard ? { type: "done", contextId } : { type: "failed", reason: "unavailable" },
          );
        for (const frame of frames.value) {
          if (typeof frame !== "string") continue;
          const decoded = decodeDialogueMessage(frame);
          if (decoded._tag === "None") continue;
          const message = decoded.value;
          if (message.error !== undefined)
            return yield* report(contextId, {
              type: "failed",
              reason: elevenLabsFailureReason(message.error),
            });
          if (message.audio) {
            heard = true;
            yield* report(contextId, {
              type: "audio",
              contextId,
              pcm: Buffer.from(message.audio, "base64"),
              alignment: message.alignment
                ? {
                    chars: message.alignment.chars,
                    startMs: message.alignment.char_start_times_ms,
                  }
                : undefined,
            });
          }
          if (message.is_final) return yield* report(contextId, { type: "done", contextId });
        }
      }
    });

    const stop = (contextId: string) =>
      Effect.suspend(() => {
        const speech = speeches.get(contextId);
        speeches.delete(contextId);
        return speech === undefined ? Effect.void : Scope.close(speech, Exit.void);
      });

    return {
      speak: Effect.fn("ElevenLabsVoice.startDialogueSpeech")(function* (contextId, text) {
        const speech = yield* Scope.fork(scope);
        speeches.set(contextId, speech);
        yield* run(contextId, text).pipe(
          Effect.catch((error) => report(contextId, { type: "failed", reason: error.reason })),
          Effect.ensuring(stop(contextId)),
          Scope.provide(speech),
          Effect.provideService(Socket.WebSocketConstructor, constructor),
          Effect.forkIn(speech),
        );
      }),
      // Closing the scope closes the socket, so no audio for this speech arrives afterwards.
      cancel: (contextId) =>
        Effect.sync(() => cancelled.add(contextId)).pipe(Effect.andThen(stop(contextId))),
    } satisfies VoiceSynthesizer;
  },
);

/** `baseUrl` exists for tests; production always derives the host from the server location. */
export const makeLayer = (options?: { readonly baseUrl?: string }) =>
  Layer.effect(
    VoiceSpeechProvider,
    Effect.gen(function* () {
      const constructor = yield* Socket.WebSocketConstructor;
      return VoiceSpeechProvider.of({
        connect: Effect.fn("ElevenLabsVoice.connect")(function* (
          config: VoiceSpeechConfig,
          sinks: VoiceSpeechSinks,
        ) {
          const baseUrl = options?.baseUrl ?? HOSTS[config.serverLocation];
          const [transcriber, synthesizer] = yield* Effect.all(
            [
              connectTranscriber(baseUrl, config, sinks.onTranscriber),
              usesDialogueSocket(config.textToSpeechModel)
                ? connectDialogueSynthesizer(baseUrl, config, sinks.onSynthesizer)
                : connectSynthesizer(baseUrl, config, sinks.onSynthesizer),
            ],
            { concurrency: 2 },
          ).pipe(Effect.provideService(Socket.WebSocketConstructor, constructor));
          return { transcriber, synthesizer };
        }),
      });
    }),
  );

export const layer = makeLayer().pipe(Layer.provide(upstreamWebSocketConstructor));
