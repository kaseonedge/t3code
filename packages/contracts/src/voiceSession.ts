import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
} from "./baseSchemas.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";
import { SPEECH_STREAM_MAX_CHUNK_BYTES } from "./speech.ts";

/** Goes into the request path of the speech socket, so it is one path segment and nothing else. */
export const ElevenLabsVoiceId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{1,64}$/));
/** Goes into the query string of both sockets. */
export const ElevenLabsModelId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
);

/** A closed set: the key is only ever sent to a host this list maps to. */
export const ElevenLabsServerLocation = Schema.Literals(["global", "us", "eu", "in"]);
export type ElevenLabsServerLocation = typeof ElevenLabsServerLocation.Type;

const DEFAULT_ELEVENLABS_SPEECH_TO_TEXT_MODEL = "scribe_v2_realtime";
const DEFAULT_ELEVENLABS_TEXT_TO_SPEECH_MODEL = "eleven_flash_v2_5";

export const ElevenLabsSettings = Schema.Struct({
  apiKey: SettingsSecretValue.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  voiceId: Schema.Union([Schema.Literal(""), ElevenLabsVoiceId]).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  speechToTextModel: ElevenLabsModelId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ELEVENLABS_SPEECH_TO_TEXT_MODEL)),
  ),
  textToSpeechModel: ElevenLabsModelId.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ELEVENLABS_TEXT_TO_SPEECH_MODEL)),
  ),
  serverLocation: ElevenLabsServerLocation.pipe(
    Schema.withDecodingDefault(Effect.succeed("global" as const)),
  ),
  /** Asks ElevenLabs not to keep audio or text. Only some plans honor it. */
  zeroRetention: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ElevenLabsSettings = typeof ElevenLabsSettings.Type;

export const ElevenLabsSettingsPatch = Schema.Struct({
  apiKey: Schema.optionalKey(SettingsSecretValue),
  voiceId: Schema.optionalKey(Schema.Union([Schema.Literal(""), ElevenLabsVoiceId])),
  speechToTextModel: Schema.optionalKey(ElevenLabsModelId),
  textToSpeechModel: Schema.optionalKey(ElevenLabsModelId),
  serverLocation: Schema.optionalKey(ElevenLabsServerLocation),
  zeroRetention: Schema.optionalKey(Schema.Boolean),
});

/**
 * Where a voice conversation sends this device's microphone audio and the bot's words: through
 * one environment to ElevenLabs. Its own grant, so consent to dictation never starts a conversation.
 */
export const VoiceConversationDestination = Schema.Struct({
  kind: Schema.Literal("elevenlabs"),
  environmentId: EnvironmentId,
});
export type VoiceConversationDestination = typeof VoiceConversationDestination.Type;

export const VoiceConversationGrant = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  destination: VoiceConversationDestination,
});
export type VoiceConversationGrant = typeof VoiceConversationGrant.Type;

export const VOICE_SESSION_PATH = "/ws/voice-session";
/**
 * Starts the text of a turn the user spoke, so the voice thread's agent knows to answer for the
 * ear. It is for the agent only: clients show the user's words without it.
 */
export const VOICE_UTTERANCE_PREFIX = "[voice] ";
/** Starts the id of a message that came from speech. The id, not the text, marks its source. */
export const VOICE_MESSAGE_ID_PREFIX = "voice-message:";
/** Microphone audio: 16 kHz mono Float32 PCM, the same frames `/ws/voice` takes. */
export const VOICE_SESSION_INPUT_SAMPLE_RATE = 16_000;
export const VOICE_SESSION_MAX_CHUNK_BYTES = SPEECH_STREAM_MAX_CHUNK_BYTES;
/** Speech audio: 24 kHz mono signed 16-bit little-endian PCM after a 4-byte speech id. */
export const VOICE_SESSION_OUTPUT_SAMPLE_RATE = 24_000;
export const VOICE_SESSION_MAX_COMMAND_BYTES = 4_096;

export const VOICE_SAY_MAX_WORDS = 40;
export const VOICE_SAY_MAX_SENTENCES = 2;
const VOICE_SAY_MAX_CHARS = 600;

/** A reply answers what the user just said. A question needs the user. An announcement can wait. */
export const VoiceSayPriority = Schema.Literals(["reply", "question", "announcement"]);
export type VoiceSayPriority = typeof VoiceSayPriority.Type;

export const VoiceLocalCommand = Schema.Literals([
  "stop",
  "quiet",
  "resume",
  "repeat",
  "louder",
  "quieter",
]);
export type VoiceLocalCommand = typeof VoiceLocalCommand.Type;

export const VoiceSessionErrorReason = Schema.Literals([
  "not-configured",
  "unreadable-key",
  "rejected-key",
  "rate-limit",
  "zero-retention-unavailable",
  "no-router",
  "already-active",
  "router-unavailable",
  "unavailable",
]);
export type VoiceSessionErrorReason = typeof VoiceSessionErrorReason.Type;

export class VoiceSessionError extends Schema.TaggedError<VoiceSessionError>()(
  "VoiceSessionError",
  { reason: VoiceSessionErrorReason },
) {
  override get message() {
    switch (this.reason) {
      case "not-configured":
        return "Add your ElevenLabs API key and a voice in Settings → Voice.";
      case "unreadable-key":
        return "Couldn’t read the ElevenLabs API key. Unlock the vault on this environment or update the key in Settings → Voice. No audio was sent to ElevenLabs.";
      case "rejected-key":
        return "ElevenLabs rejected this API key. Check its permissions and billing in Settings → Voice.";
      case "rate-limit":
        return "ElevenLabs reached a usage limit. Check the account's quota or try again later.";
      case "zero-retention-unavailable":
        return "ElevenLabs would not turn off retention for this account, so the conversation was stopped. Turn off zero retention in Settings → Voice, or use a plan that supports it.";
      case "no-router":
        return "Choose the thread that answers voice conversations in Settings → Voice.";
      case "already-active":
        return "A voice conversation is already running on this environment. End it first.";
      case "router-unavailable":
        return "The voice thread couldn’t take that message. Check that it still exists and isn’t archived.";
      case "unavailable":
        return "The voice conversation stopped because ElevenLabs couldn’t be reached. Try again.";
    }
  }
}

export const VoiceSessionCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("start") }),
  /** Answers `clear`: playback of this speech stopped after `playedMs` of its audio was heard. */
  Schema.Struct({
    type: Schema.Literal("cleared"),
    speechId: PositiveInt,
    playedMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({ type: Schema.Literal("stop") }),
]);
export type VoiceSessionCommand = typeof VoiceSessionCommand.Type;

export const VoiceSessionEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), routerThreadId: ThreadId }),
  /** What the user is saying. A final transcript ends their turn. */
  Schema.Struct({
    type: Schema.Literal("transcript"),
    text: Schema.String,
    final: Schema.Boolean,
  }),
  /** The turn went to the voice thread; the client marks it at once, before any model answers. */
  Schema.Struct({ type: Schema.Literal("acknowledged"), text: Schema.String }),
  /** The turn was handled here, with no model call. */
  Schema.Struct({ type: Schema.Literal("local_command"), command: VoiceLocalCommand }),
  /** Binary frames carrying this speech id follow. */
  Schema.Struct({
    type: Schema.Literal("speech_start"),
    speechId: PositiveInt,
    priority: VoiceSayPriority,
    text: Schema.String,
  }),
  /** Drop every buffered frame of this speech now, then answer `cleared`. */
  Schema.Struct({ type: Schema.Literal("clear"), speechId: PositiveInt }),
  Schema.Struct({
    type: Schema.Literal("speech_end"),
    speechId: PositiveInt,
    outcome: Schema.Literals(["delivered", "interrupted"]),
    spokenText: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("status"),
    userSpeaking: Schema.Boolean,
    quiet: Schema.Boolean,
    queued: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    reason: VoiceSessionErrorReason,
    message: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("ended") }),
]);
export type VoiceSessionEvent = typeof VoiceSessionEvent.Type;

const AUDIO_HEADER_BYTES = 4;

export function encodeVoiceSessionAudioFrame(speechId: number, pcm: Uint8Array): Uint8Array {
  const frame = new Uint8Array(AUDIO_HEADER_BYTES + pcm.byteLength);
  new DataView(frame.buffer).setUint32(0, speechId, true);
  frame.set(pcm, AUDIO_HEADER_BYTES);
  return frame;
}

export function decodeVoiceSessionAudioFrame(
  frame: Uint8Array,
): { readonly speechId: number; readonly pcm: Uint8Array } | undefined {
  if (frame.byteLength < AUDIO_HEADER_BYTES) return undefined;
  return {
    speechId: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true),
    pcm: frame.subarray(AUDIO_HEADER_BYTES),
  };
}

/** Enough to follow a day's work; more would bury the user in announcements. */
export const VOICE_WATCH_LIMIT = 20;
export const VoiceWatchedThreadIds = Schema.Array(ThreadId).check(
  Schema.isMaxLength(VOICE_WATCH_LIMIT),
);

export const VoiceWatchInput = Schema.Struct({
  action: Schema.Literals(["watch", "unwatch", "list"]),
  threadId: Schema.optional(ThreadId).annotate({
    description: "The thread to start or stop watching. Not needed for list.",
  }),
});
export type VoiceWatchInput = typeof VoiceWatchInput.Type;

export const VoiceWatchResult = Schema.Struct({
  watched: Schema.Array(ThreadId),
  limit: PositiveInt,
});
export type VoiceWatchResult = typeof VoiceWatchResult.Type;

/** Something that went wrong with a conversation, kept so a watchdog can report it later. */
export const VoiceHealthEntry = Schema.Struct({
  seq: PositiveInt,
  at: IsoDateTime,
  kind: Schema.Union([VoiceSessionErrorReason, Schema.Literal("first-audio-timeout")]),
});
export type VoiceHealthEntry = typeof VoiceHealthEntry.Type;

export const VoiceHealthFinding = Schema.Struct({
  /** Stable while the problem lasts, so it is reported once. */
  key: Schema.String,
  kind: Schema.Literals(["conversation", "voice-thread-stalled", "worker-stalled"]),
  threadId: Schema.NullOr(ThreadId),
  summary: Schema.String,
  since: IsoDateTime,
});
export type VoiceHealthFinding = typeof VoiceHealthFinding.Type;

export const VoiceHealthReport = Schema.Struct({
  checkedAt: IsoDateTime,
  /** Problems not reported before. Empty means there is nothing new to tell the user. */
  findings: Schema.Array(VoiceHealthFinding),
  /** Problems already reported that are still going on. */
  ongoing: NonNegativeInt,
});
export type VoiceHealthReport = typeof VoiceHealthReport.Type;

export const VoiceSayInput = Schema.Struct({
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(VOICE_SAY_MAX_CHARS),
  ).annotate({
    description: `What to say aloud: at most ${VOICE_SAY_MAX_WORDS} words in ${VOICE_SAY_MAX_SENTENCES} sentences, plain speech with no markdown, code, paths or ids.`,
  }),
  priority: Schema.optional(VoiceSayPriority).annotate({
    description:
      "reply (default): answers what the user just said. question: you need the user to decide something. announcement: news they did not ask for, such as a finished task.",
  }),
});
export type VoiceSayInput = typeof VoiceSayInput.Type;

export const VoiceSayResult = Schema.Struct({
  /** `held`: not spoken yet. It stays queued and plays when the user allows. */
  outcome: Schema.Literals(["delivered", "interrupted", "held"]),
  /** The words the user actually heard. */
  spokenText: Schema.String,
});
export type VoiceSayResult = typeof VoiceSayResult.Type;

export const VoiceStatusResult = Schema.Struct({
  active: Schema.Boolean,
  routerThreadId: Schema.NullOr(ThreadId),
  userSpeaking: Schema.Boolean,
  quiet: Schema.Boolean,
  speaking: Schema.NullOr(Schema.String),
  queued: NonNegativeInt,
  lastHeard: Schema.NullOr(Schema.String),
  lastSpoken: Schema.NullOr(
    Schema.Struct({
      outcome: Schema.Literals(["delivered", "interrupted"]),
      spokenText: Schema.String,
    }),
  ),
});
export type VoiceStatusResult = typeof VoiceStatusResult.Type;

export const VOICE_REALTIME_PATH = "/ws/voice-realtime";
export const VOICE_REALTIME_SAMPLE_RATE = 24_000;
export const VOICE_REALTIME_MAX_COMMAND_BYTES = 32_768;

const VoiceOperationId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
export const VoiceRealtimeCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("start"), threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("submit"),
    operationId: VoiceOperationId,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  }),
  Schema.Struct({ type: Schema.Literal("recover"), operationId: VoiceOperationId }),
  Schema.Struct({ type: Schema.Literal("stop") }),
]);
export type VoiceRealtimeCommand = typeof VoiceRealtimeCommand.Type;

export const VoiceRealtimeEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), value: Schema.String, threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("receipt"),
    operationId: VoiceOperationId,
    runId: Schema.String,
    status: Schema.String,
    link: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    operationId: VoiceOperationId,
    resultId: Schema.String,
    status: Schema.String,
    text: Schema.String,
    link: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    operationId: Schema.optional(VoiceOperationId),
    message: Schema.String,
  }),
]);
export type VoiceRealtimeEvent = typeof VoiceRealtimeEvent.Type;
