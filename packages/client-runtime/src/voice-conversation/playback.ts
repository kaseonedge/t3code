import { VOICE_SESSION_OUTPUT_SAMPLE_RATE } from "@t3tools/contracts";

/** Where decoded speech goes. The browser's audio clock is the only source of timing. */
export interface VoiceAudioSink {
  /** Seconds on the output clock. */
  readonly now: () => number;
  /** Plays mono samples starting at `at` seconds. The handle stops them, played or not. */
  readonly schedule: (samples: Float32Array, at: number) => { readonly stop: () => void };
  readonly setVolume: (volume: number) => void;
}

interface Speech {
  readonly id: number;
  /** When its first sample plays, on the output clock. */
  readonly startsAt: number;
  endsAt: number;
  readonly sources: Array<{ readonly stop: () => void }>;
  /** A 16-bit sample split across two frames. */
  carry: number | undefined;
}

/** Enough to ride out one late network frame without an audible gap. */
const LEAD_SECONDS = 0.06;
const VOLUME_STEP = 0.25;
const MAX_VOLUME = 2;

/**
 * Plays speech as it arrives and can stop it at once. Only one speech is audible at a time;
 * a speech that was cleared stays cleared, so frames still in flight for it are never heard.
 */
export function createVoicePlayback(sink: VoiceAudioSink) {
  let current: Speech | undefined;
  const cleared = new Set<number>();
  let volume = 1;

  const stop = (speech: Speech) => {
    for (const source of speech.sources) source.stop();
    speech.sources.length = 0;
  };

  /** Milliseconds of `speech` that have actually played by now. */
  const playedMs = (speech: Speech) =>
    Math.max(0, Math.min(sink.now(), speech.endsAt) - speech.startsAt) * 1000;

  return {
    /** Queues 24 kHz signed 16-bit little-endian PCM for `speechId`. */
    enqueue(speechId: number, pcm: Uint8Array) {
      if (cleared.has(speechId)) return;
      if (current?.id !== speechId) {
        if (current) stop(current);
        const startsAt = sink.now() + LEAD_SECONDS;
        current = { id: speechId, startsAt, endsAt: startsAt, sources: [], carry: undefined };
      }
      const speech = current;
      let bytes = pcm;
      if (speech.carry !== undefined) {
        const joined = new Uint8Array(pcm.byteLength + 1);
        joined[0] = speech.carry;
        joined.set(pcm, 1);
        bytes = joined;
      }
      const count = bytes.byteLength >> 1;
      speech.carry = bytes.byteLength % 2 === 1 ? bytes[bytes.byteLength - 1] : undefined;
      if (count === 0) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
      const samples = new Float32Array(count);
      for (let index = 0; index < count; index++)
        samples[index] = view.getInt16(index * 2, true) / 32768;
      // An underrun restarts from now; otherwise chunks butt up against each other exactly.
      const at = Math.max(speech.endsAt, sink.now());
      speech.sources.push(sink.schedule(samples, at));
      speech.endsAt = at + count / VOICE_SESSION_OUTPUT_SAMPLE_RATE;
    },
    /** Silences `speechId` now and returns how many milliseconds of it were heard. */
    clear(speechId: number): number {
      cleared.add(speechId);
      if (current?.id !== speechId) return 0;
      const played = playedMs(current);
      stop(current);
      current = undefined;
      return played;
    },
    isDrained(speechId: number): boolean {
      return current?.id === speechId && sink.now() >= current.endsAt;
    },
    /** Silences everything, as when the conversation ends. */
    reset() {
      if (current) stop(current);
      current = undefined;
      cleared.clear();
    },
    adjustVolume(direction: "louder" | "quieter") {
      volume = Math.max(
        VOLUME_STEP,
        Math.min(MAX_VOLUME, volume + (direction === "louder" ? VOLUME_STEP : -VOLUME_STEP)),
      );
      sink.setVolume(volume);
      return volume;
    },
  };
}

export type VoicePlayback = ReturnType<typeof createVoicePlayback>;
