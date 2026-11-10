import {
  encodeVoiceSessionAudioFrame,
  ThreadId,
  VOICE_SESSION_MAX_CHUNK_BYTES,
  type VoiceSessionEvent,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import type { VoicePlayback } from "./playback.ts";
import { openVoiceConversation, type VoiceConversationState } from "./session.ts";

class TestSocket extends EventTarget {
  sent: (string | Uint8Array)[] = [];
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "";
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  receive(event: VoiceSessionEvent) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
  receiveAudio(frame: Uint8Array) {
    this.dispatchEvent(new MessageEvent("message", { data: frame.slice().buffer }));
  }
  commands() {
    return this.sent.flatMap((data) => (typeof data === "string" ? [JSON.parse(data)] : []));
  }
}

function connect(canSend = () => true) {
  const socket = new TestSocket();
  const states: VoiceConversationState[] = [];
  const playback = {
    enqueue: vi.fn(),
    clear: vi.fn(() => 420),
    reset: vi.fn(),
    adjustVolume: vi.fn(() => 1),
  } satisfies VoicePlayback;
  const onAcknowledged = vi.fn();
  const conversation = openVoiceConversation({
    url: "wss://environment.test/ws/voice-session",
    playback,
    canSend,
    onState: (state) => states.push(state),
    onAcknowledged,
    createSocket: () => socket as unknown as WebSocket,
  });
  socket.dispatchEvent(new Event("open"));
  return { socket, states, playback, onAcknowledged, conversation, state: () => states.at(-1)! };
}

const ready = { type: "ready", routerThreadId: ThreadId.make("voice-router") } as const;

it("sends no microphone audio until the conversation is live, then streams it in bounded frames", () => {
  const { socket, conversation, state } = connect();
  expect(socket.commands()).toEqual([{ type: "start" }]);
  conversation.feed(new Float32Array([0.1]));
  expect(socket.sent).toHaveLength(1);

  socket.receive(ready);
  expect(state().phase).toBe("live");
  conversation.feed(new Float32Array(VOICE_SESSION_MAX_CHUNK_BYTES / 4 + 1));
  expect(socket.sent.slice(1).map((frame) => (frame as Uint8Array).byteLength)).toEqual([
    VOICE_SESSION_MAX_CHUNK_BYTES,
    4,
  ]);
  // A link that cannot keep up loses audio instead of delivering it late.
  socket.bufferedAmount = VOICE_SESSION_MAX_CHUNK_BYTES * 5;
  conversation.feed(new Float32Array([0.2]));
  expect(socket.sent).toHaveLength(3);
});

it("plays speech frames, and answers a clear with the milliseconds actually played", () => {
  const { socket, playback, state } = connect();
  socket.receive(ready);
  socket.receive({
    type: "speech_start",
    speechId: 3,
    priority: "reply",
    text: "The build passed.",
  });
  expect(state().speaking).toEqual({ text: "The build passed.", priority: "reply" });
  socket.receiveAudio(encodeVoiceSessionAudioFrame(3, new Uint8Array([1, 2])));
  expect(playback.enqueue).toHaveBeenCalledWith(3, new Uint8Array([1, 2]));

  socket.receive({ type: "clear", speechId: 3 });
  expect(playback.clear).toHaveBeenCalledWith(3);
  expect(socket.commands().at(-1)).toEqual({ type: "cleared", speechId: 3, playedMs: 420 });
  socket.receive({ type: "speech_end", speechId: 3, outcome: "interrupted", spokenText: "The" });
  expect(state().speaking).toBeNull();
});

it("tracks what the server reports and handles volume and acknowledgement locally", () => {
  const { socket, playback, onAcknowledged, state } = connect();
  socket.receive(ready);
  socket.receive({ type: "transcript", text: "fix the login", final: false });
  socket.receive({ type: "status", userSpeaking: true, quiet: true, queued: 2 });
  expect(state()).toMatchObject({
    heard: "fix the login",
    userSpeaking: true,
    quiet: true,
    queued: 2,
  });
  socket.receive({ type: "acknowledged", text: "Fix the login." });
  expect(onAcknowledged).toHaveBeenCalledTimes(1);
  socket.receive({ type: "local_command", command: "louder" });
  socket.receive({ type: "local_command", command: "stop" });
  expect(playback.adjustVolume.mock.calls).toEqual([["louder"]]);
});

it.each([
  [
    "a server error",
    (socket: TestSocket) =>
      socket.receive({ type: "error", reason: "unreadable-key", message: "Unlock the vault." }),
    { phase: "failed", error: { reason: "unreadable-key", message: "Unlock the vault." } },
  ],
  [
    "a dropped connection",
    (socket: TestSocket) => socket.close(),
    { phase: "failed", error: { reason: "connection" } },
  ],
  [
    "the server ending it",
    (socket: TestSocket) => socket.receive({ type: "ended" }),
    { phase: "ended", error: null },
  ],
] as const)("silences playback and stops sending after %s", (_name, end, expected) => {
  const { socket, playback, conversation, state } = connect();
  socket.receive(ready);
  socket.receive({ type: "speech_start", speechId: 1, priority: "reply", text: "Hi." });
  end(socket);
  expect(state()).toMatchObject({ ...expected, speaking: null, userSpeaking: false });
  expect(playback.reset).toHaveBeenCalledTimes(1);
  const sent = socket.sent.length;
  conversation.feed(new Float32Array([0.1]));
  expect(socket.sent).toHaveLength(sent);
});

it("stops at once when consent is revoked mid-conversation", () => {
  let consent = true;
  const { socket, conversation, state, playback } = connect(() => consent);
  socket.receive(ready);
  consent = false;
  conversation.feed(new Float32Array([0.1]));
  expect(socket.sent).toHaveLength(1);
  expect(state().phase).toBe("failed");
  expect(playback.reset).toHaveBeenCalled();
});

it("stop tells the server and ends cleanly", () => {
  const { socket, conversation, state } = connect();
  socket.receive(ready);
  conversation.stop();
  expect(socket.commands().at(-1)).toEqual({ type: "stop" });
  expect(state()).toMatchObject({ phase: "ended", error: null });
});
