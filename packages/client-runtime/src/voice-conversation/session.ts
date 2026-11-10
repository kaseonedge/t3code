import {
  decodeVoiceSessionAudioFrame,
  VOICE_SESSION_MAX_CHUNK_BYTES,
  type VoiceSessionCommand,
  VoiceSessionEvent,
  type VoiceSessionErrorReason,
  type VoiceSayPriority,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { VoicePlayback } from "./playback.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(VoiceSessionEvent));

/** Microphone audio the socket has not sent yet. Beyond this the link is too slow to converse. */
const MAX_BUFFERED_BYTES = VOICE_SESSION_MAX_CHUNK_BYTES * 4;

export interface VoiceConversationState {
  readonly phase: "connecting" | "live" | "ended" | "failed";
  readonly userSpeaking: boolean;
  readonly quiet: boolean;
  readonly queued: number;
  /** What the user is saying, or last said. */
  readonly heard: string;
  /** False while `heard` is still changing; true once the turn ended and the words are final. */
  readonly heardFinal: boolean;
  /** What the bot is saying now. */
  readonly speaking: { readonly text: string; readonly priority: VoiceSayPriority } | null;
  readonly error: {
    readonly reason: VoiceSessionErrorReason | "connection";
    readonly message: string;
  } | null;
}

export const INITIAL_VOICE_CONVERSATION_STATE: VoiceConversationState = {
  phase: "connecting",
  userSpeaking: false,
  quiet: false,
  queued: 0,
  heard: "",
  heardFinal: true,
  speaking: null,
  error: null,
};

/**
 * One live conversation over `/ws/voice-session`. Audio is never buffered for later: a frame that
 * cannot go out now is dropped, because late speech is worse than missing speech.
 */
export function openVoiceConversation(input: {
  readonly url: string;
  readonly playback: VoicePlayback;
  /** Checked before every send, so revoking consent stops audio at once. */
  readonly canSend: () => boolean;
  readonly onState: (state: VoiceConversationState) => void;
  /** The turn went to the voice thread; fires before any model has answered. */
  readonly onAcknowledged: () => void;
  readonly createSocket?: (url: string) => WebSocket;
}) {
  const socket = (input.createSocket ?? ((url) => new WebSocket(url)))(input.url);
  socket.binaryType = "arraybuffer";
  let state = INITIAL_VOICE_CONVERSATION_STATE;
  let done = false;
  const update = (patch: Partial<VoiceConversationState>) => {
    state = { ...state, ...patch };
    input.onState(state);
  };
  const send = (command: VoiceSessionCommand) => socket.send(JSON.stringify(command));
  const finish = (patch: Partial<VoiceConversationState>) => {
    if (done) return;
    done = true;
    input.playback.reset();
    update({ userSpeaking: false, speaking: null, queued: 0, ...patch });
    socket.close();
  };
  const fail = (message: string, reason: VoiceSessionErrorReason | "connection" = "connection") =>
    finish({ phase: "failed", error: { reason, message } });
  const revoked = () => {
    if (input.canSend()) return false;
    fail("Voice conversation consent was turned off.");
    return true;
  };

  const handle = (event: VoiceSessionEvent) => {
    switch (event.type) {
      case "ready":
        return update({ phase: "live" });
      case "transcript":
        return update({ heard: event.text, heardFinal: event.final });
      case "acknowledged":
        return input.onAcknowledged();
      case "local_command":
        if (event.command === "louder" || event.command === "quieter")
          input.playback.adjustVolume(event.command);
        return;
      case "speech_start":
        return update({ speaking: { text: event.text, priority: event.priority } });
      case "clear":
        // The server waits on this to learn what the user actually heard.
        return send({
          type: "cleared",
          speechId: event.speechId,
          playedMs: input.playback.clear(event.speechId),
        });
      case "speech_end":
        return update({ speaking: null });
      case "status":
        return update({
          userSpeaking: event.userSpeaking,
          quiet: event.quiet,
          queued: event.queued,
        });
      case "error":
        return fail(event.message, event.reason);
      case "ended":
        return finish({ phase: "ended" });
    }
  };

  socket.addEventListener("open", () => {
    if (!done && !revoked()) send({ type: "start" });
  });
  socket.addEventListener("message", (message: MessageEvent<string | ArrayBuffer>) => {
    if (done || revoked()) return;
    try {
      if (typeof message.data === "string") return handle(decodeEvent(message.data));
      const frame = decodeVoiceSessionAudioFrame(new Uint8Array(message.data));
      if (frame) input.playback.enqueue(frame.speechId, frame.pcm);
    } catch {
      fail("The voice conversation sent something this app does not understand.");
    }
  });
  socket.addEventListener("close", () => fail("The voice connection closed."));
  socket.addEventListener("error", () => fail("Could not connect to the voice conversation."));
  input.onState(state);

  return {
    /** 16 kHz mono microphone samples. */
    feed(pcm: Float32Array) {
      if (done || state.phase !== "live" || revoked()) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let offset = 0; offset < bytes.byteLength; offset += VOICE_SESSION_MAX_CHUNK_BYTES)
        socket.send(bytes.slice(offset, offset + VOICE_SESSION_MAX_CHUNK_BYTES));
    },
    stop() {
      if (done) return;
      if (socket.readyState === 1) send({ type: "stop" });
      finish({ phase: "ended" });
    },
  };
}

export type VoiceConversation = ReturnType<typeof openVoiceConversation>;
