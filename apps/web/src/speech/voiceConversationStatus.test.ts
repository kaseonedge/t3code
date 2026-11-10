import { INITIAL_VOICE_CONVERSATION_STATE } from "@t3tools/client-runtime/voice-conversation";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import type { VoiceConversationSnapshot } from "./voiceConversation";
import { voiceConversationBlocker, voiceConversationStatus } from "./voiceConversationStatus";

const live: VoiceConversationSnapshot = {
  ...INITIAL_VOICE_CONVERSATION_STATE,
  phase: "live",
  environmentId: EnvironmentId.make("env-1"),
  acknowledged: false,
  heard: "fix the login",
};
const speaking = { text: "Should I merge it?", priority: "question" } as const;

it.each([
  [null, "Off", ""],
  [{ ...live, phase: "connecting" }, "Connecting", ""],
  [
    { ...live, phase: "failed", error: { reason: "no-router", message: "Choose a thread." } },
    "Stopped",
    "Choose a thread.",
  ],
  // The user talking outranks everything: that is when the bot must visibly yield.
  [{ ...live, userSpeaking: true, speaking, quiet: true }, "Hearing you", "fix the login"],
  [{ ...live, speaking }, "Asking you", "Should I merge it?"],
  [{ ...live, speaking: { ...speaking, priority: "reply" } }, "Speaking", "Should I merge it?"],
  [{ ...live, acknowledged: true }, "Heard you", "fix the login"],
  [{ ...live, quiet: true, queued: 2 }, "Quiet", "2 things waiting to be said"],
  [live, "Listening", "fix the login"],
] as const)("%# shows the right state", (snapshot, label, detail) => {
  expect(voiceConversationStatus(snapshot as VoiceConversationSnapshot | null)).toMatchObject({
    label,
    detail,
  });
});

const ready = {
  connected: true,
  keySaved: true,
  voiceId: "VoiceFixture01",
  voiceThreadId: ThreadId.make("voice-router"),
  consented: true,
};

// The server refuses each of these too; the client names the first thing to fix before asking.
it.each([
  [{}, undefined],
  [{ consented: false }, "Allow voice conversations on this device."],
  [{ voiceThreadId: null, consented: false }, "Choose the thread that answers."],
  [{ keySaved: false, voiceId: "" }, "Add an ElevenLabs API key."],
  [{ connected: false, keySaved: false }, "This environment is not connected."],
] as const)("%# names what still blocks a start", (missing, reason) => {
  expect(voiceConversationBlocker({ ...ready, ...missing })).toBe(reason);
});
