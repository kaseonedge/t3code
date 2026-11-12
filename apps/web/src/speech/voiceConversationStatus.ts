import type { ThreadId } from "@t3tools/contracts";
import type { VoiceConversationSnapshot } from "./voiceConversation";

export interface VoiceConversationStatus {
  readonly label: string;
  readonly tone: "idle" | "live" | "attention" | "error";
  /** The line under the label: what was heard or is being said. */
  readonly detail: string;
}

/** One line of state for the panel. The first matching row wins. */
export function voiceConversationStatus(
  snapshot: VoiceConversationSnapshot | null,
): VoiceConversationStatus {
  if (snapshot === null || snapshot.phase === "ended")
    return { label: "Off", tone: "idle", detail: "" };
  if (snapshot.phase === "failed")
    return { label: "Stopped", tone: "error", detail: snapshot.error?.message ?? "" };
  if (snapshot.phase === "connecting") return { label: "Connecting", tone: "idle", detail: "" };
  if (snapshot.error)
    return { label: "Voice issue", tone: "error", detail: snapshot.error.message };
  if (snapshot.userSpeaking) return { label: "Hearing you", tone: "live", detail: snapshot.heard };
  if (snapshot.speaking)
    return {
      label: snapshot.realtimeTarget
        ? "Audio received"
        : snapshot.speaking.priority === "question"
          ? "Asking you"
          : "Speaking",
      tone: snapshot.speaking.priority === "question" ? "attention" : "live",
      detail: snapshot.speaking.text,
    };
  if (snapshot.acknowledged) return { label: "Heard you", tone: "live", detail: snapshot.heard };
  const waiting =
    snapshot.queued > 0
      ? `${snapshot.queued} ${snapshot.queued === 1 ? "thing" : "things"} waiting to be said`
      : snapshot.heard;
  return snapshot.quiet
    ? { label: "Quiet", tone: "idle", detail: waiting }
    : { label: "Listening", tone: "live", detail: waiting };
}

/** Why a conversation cannot start yet, in the order the user would fix things. */
export function voiceConversationBlocker(input: {
  readonly connected: boolean;
  readonly keySaved: boolean;
  readonly voiceId: string;
  readonly voiceThreadId: ThreadId | null;
  readonly consented: boolean;
}): string | undefined {
  if (!input.connected) return "This environment is not connected.";
  if (!input.keySaved) return "Add an ElevenLabs API key.";
  if (!input.voiceId) return "Enter an ElevenLabs voice.";
  if (input.voiceThreadId === null) return "Choose the thread that answers.";
  if (!input.consented) return "Allow voice conversations on this device.";
  return undefined;
}
