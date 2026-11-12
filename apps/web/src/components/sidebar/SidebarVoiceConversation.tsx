import { stopVoiceConversation, useVoiceConversation } from "../../speech/voiceConversation";
import { VoiceConversationPanel } from "../settings/VoiceConversationPanel";

/** A live microphone is always visible and one click from off, wherever the user has navigated. */
export function SidebarVoiceConversation() {
  const snapshot = useVoiceConversation();
  if (!snapshot || snapshot.phase === "ended") return null;
  return (
    <div className="rounded-md border bg-card px-2 py-1.5">
      <VoiceConversationPanel snapshot={snapshot} onStop={stopVoiceConversation} />
    </div>
  );
}
