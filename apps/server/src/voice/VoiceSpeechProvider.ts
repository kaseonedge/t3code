import type {
  ElevenLabsSettings,
  VoiceSessionError,
  VoiceSessionErrorReason,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";

export type VoiceTranscriberEvent =
  /** Words heard so far in the user's turn. */
  | { readonly type: "partial"; readonly text: string }
  /** The user's turn ended with these words. */
  | { readonly type: "committed"; readonly text: string }
  | { readonly type: "failed"; readonly reason: VoiceSessionErrorReason };

/** Live speech to text for one conversation. */
export interface VoiceTranscriber {
  /** 16 kHz mono Float32 PCM, as the client sent it. */
  readonly send: (pcm: Uint8Array) => Effect.Effect<void>;
}

/** When each character of a chunk starts, in milliseconds from the start of that chunk. */
export interface VoiceAudioAlignment {
  readonly chars: ReadonlyArray<string>;
  readonly startMs: ReadonlyArray<number>;
}

export type VoiceSynthesizerEvent =
  | {
      readonly type: "audio";
      readonly contextId: string;
      /** 24 kHz mono signed 16-bit little-endian PCM. */
      readonly pcm: Uint8Array;
      readonly alignment?: VoiceAudioAlignment | undefined;
    }
  | { readonly type: "done"; readonly contextId: string }
  | { readonly type: "failed"; readonly reason: VoiceSessionErrorReason };

/** Text to speech for one conversation. Each context is one thing the bot says. */
export interface VoiceSynthesizer {
  readonly speak: (contextId: string, text: string) => Effect.Effect<void>;
  /** Stops a context mid-sentence. No audio for it arrives afterwards. */
  readonly cancel: (contextId: string) => Effect.Effect<void>;
}

/** Where a connection reports what it hears and the audio it makes, in arrival order. */
export interface VoiceSpeechSinks {
  readonly onTranscriber: (event: VoiceTranscriberEvent) => Effect.Effect<void>;
  readonly onSynthesizer: (event: VoiceSynthesizerEvent) => Effect.Effect<void>;
}

export interface VoiceSpeechConnection {
  readonly transcriber: VoiceTranscriber;
  readonly synthesizer: VoiceSynthesizer;
}

export interface VoiceSpeechConfig extends Omit<ElevenLabsSettings, "apiKey" | "voiceId"> {
  readonly apiKey: Redacted.Redacted<string>;
  readonly voiceId: string;
}

/** Opens both speech connections for a conversation. They close with the scope. */
export class VoiceSpeechProvider extends Context.Service<
  VoiceSpeechProvider,
  {
    readonly connect: (
      config: VoiceSpeechConfig,
      sinks: VoiceSpeechSinks,
    ) => Effect.Effect<VoiceSpeechConnection, VoiceSessionError, Scope.Scope>;
  }
>()("t3/voice/VoiceSpeechProvider") {}
