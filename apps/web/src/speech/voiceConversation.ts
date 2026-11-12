import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  createVoicePlayback,
  INITIAL_VOICE_CONVERSATION_STATE,
  openVoiceConversation,
  type VoiceAudioSink,
  type VoiceConversation,
  type VoiceConversationState,
} from "@t3tools/client-runtime/voice-conversation";
import { getEnvironmentMediaSocketUrl } from "@t3tools/client-runtime/voice-input";
import {
  type EnvironmentId,
  type ThreadId,
  VOICE_REALTIME_PATH,
  VOICE_REALTIME_SAMPLE_RATE,
  VOICE_SESSION_OUTPUT_SAMPLE_RATE,
  VOICE_SESSION_PATH,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { randomUUID } from "../lib/utils";
import { openElevenRealtimeConversation } from "./elevenRealtimeConversation";
import workletUrl from "./pcmWorklet.ts?worker&url";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import { bindVoiceConversationGrant, readVoiceAcknowledgement } from "./voiceConversationConsent";

export interface VoiceConversationSnapshot extends VoiceConversationState {
  readonly environmentId: EnvironmentId;
  /** The last turn was handed to the voice thread and nothing has answered yet. */
  readonly acknowledged: boolean;
}

let snapshot: VoiceConversationSnapshot | null = null;
let active: { readonly stop: () => void } | undefined;
const listeners = new Set<() => void>();
const publish = (next: VoiceConversationSnapshot | null) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

/** The one conversation this window holds, or `null` when none was started. */
export function useVoiceConversation() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => null,
  );
}

function audioSink(context: AudioContext): VoiceAudioSink {
  const gain = context.createGain();
  gain.connect(context.destination);
  return {
    now: () => context.currentTime,
    schedule: (samples, at) => {
      const buffer = context.createBuffer(1, samples.length, VOICE_SESSION_OUTPUT_SAMPLE_RATE);
      buffer.getChannelData(0).set(samples);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(at);
      return {
        stop: () => {
          try {
            source.stop();
          } catch {
            // Already ended.
          }
          source.disconnect();
        },
      };
    },
    setVolume: (volume) => {
      gain.gain.value = volume;
    },
  };
}

/** A short, quiet tone: proof the turn was heard, well before any model answers. */
function acknowledgeAloud(context: AudioContext) {
  const tone = context.createOscillator();
  const gain = context.createGain();
  tone.frequency.value = 880;
  gain.gain.value = 0.04;
  tone.connect(gain).connect(context.destination);
  tone.start();
  tone.stop(context.currentTime + 0.07);
  tone.addEventListener("ended", () => gain.disconnect(), { once: true });
}

/**
 * Starts the conversation from a user gesture. The browser's echo cancellation stays on so the
 * bot's own voice from the speakers is not heard as the user interrupting.
 */
export async function startVoiceConversation(input: {
  readonly prepared: PreparedConnection;
  readonly environmentId: EnvironmentId;
  readonly grantId: string;
  readonly microphoneId: string;
  readonly realtimeThreadId?: ThreadId;
}) {
  if (active) return;
  const canSend = bindVoiceConversationGrant(input.grantId, input.environmentId);
  if (!canSend()) return;
  let stopped = false;
  let conversation: Pick<VoiceConversation, "feed" | "stop"> | undefined;
  let context: AudioContext | undefined;
  let stream: MediaStream | undefined;
  const base = { environmentId: input.environmentId, acknowledged: false };
  const release = () => {
    stopped = true;
    stream?.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => undefined);
    active = undefined;
  };
  const failed = (message: string) => {
    release();
    publish({
      ...INITIAL_VOICE_CONVERSATION_STATE,
      ...base,
      phase: "failed",
      error: { reason: "connection", message },
    });
  };
  active = {
    stop: () => {
      if (conversation) conversation.stop();
      else {
        release();
        publish(null);
      }
    },
  };
  publish({ ...INITIAL_VOICE_CONVERSATION_STATE, ...base });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(input.microphoneId ? { deviceId: { exact: input.microphoneId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (stopped) return release();
    context = new AudioContext();
    const audio = context;
    await audio.audioWorklet.addModule(workletUrl);
    const url = await runEnvironmentSpeech(
      getEnvironmentMediaSocketUrl(
        input.prepared,
        input.realtimeThreadId ? VOICE_REALTIME_PATH : VOICE_SESSION_PATH,
      ),
    );
    if (stopped) return release();
    const node = new AudioWorkletNode(audio, "t3-pcm-capture", {
      channelCount: 1,
      processorOptions: {
        live: true,
        ...(input.realtimeThreadId ? { outputSampleRate: VOICE_REALTIME_SAMPLE_RATE } : {}),
      },
    });
    const options: Parameters<typeof openVoiceConversation>[0] = {
      url,
      playback: createVoicePlayback(audioSink(audio)),
      canSend,
      onAcknowledged: () => {
        const mode = readVoiceAcknowledgement();
        if (mode === "sound") acknowledgeAloud(audio);
        if (mode === "visual" && snapshot) publish({ ...snapshot, acknowledged: true });
      },
      onState: (state) => {
        const answered = state.speaking !== null || state.userSpeaking;
        publish({
          ...state,
          environmentId: input.environmentId,
          acknowledged: answered ? false : (snapshot?.acknowledged ?? false),
        });
        if (state.phase === "ended" || state.phase === "failed") {
          node.disconnect();
          node.port.close();
          release();
        }
      },
    };
    if (input.realtimeThreadId) {
      const storageKey = `t3.voice-work.${input.environmentId}.${input.realtimeThreadId}`;
      const pending = new Set<string>();
      try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]");
        if (Array.isArray(saved))
          for (const id of saved.slice(0, 24))
            if (typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)) pending.add(id);
      } catch {
        // A restricted storage context can still run a conversation.
      }
      const save = () => {
        try {
          sessionStorage.setItem(storageKey, JSON.stringify([...pending].slice(-24)));
        } catch {
          /* Storage may be unavailable. */
        }
      };
      conversation = openElevenRealtimeConversation({
        ...options,
        threadId: input.realtimeThreadId,
        newOperationId: randomUUID,
        operations: {
          pending: () => [...pending],
          remember: (id) => {
            pending.add(id);
            save();
          },
          forget: (id) => {
            pending.delete(id);
            save();
          },
        },
      });
    } else {
      conversation = openVoiceConversation(options);
    }
    const live = conversation;
    node.port.onmessage = ({ data }: MessageEvent<Float32Array | number | string>) => {
      if (data instanceof Float32Array) live.feed(data);
    };
    for (const track of stream.getTracks())
      track.addEventListener("ended", () => live.stop(), { once: true });
    audio.createMediaStreamSource(stream).connect(node);
    // The processor emits silence, keeping the graph active without microphone playback.
    node.connect(audio.destination);
    await audio.resume();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
    node.port.postMessage("start");
  } catch (error) {
    if (stopped) return;
    failed(
      error instanceof DOMException && error.name === "NotAllowedError"
        ? "Allow microphone access in your browser to start a voice conversation."
        : "Could not start the voice conversation. Check the microphone and the connection.",
    );
  }
}

export function stopVoiceConversation() {
  active?.stop();
}
