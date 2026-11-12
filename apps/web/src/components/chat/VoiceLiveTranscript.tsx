import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useVoiceConversation } from "../../speech/voiceConversation";

/**
 * Words being spoken right now, shown at the foot of the chat while a conversation is on. They
 * are provisional: nothing here is saved. The finished turn and the finished reply arrive as
 * ordinary messages in the voice thread, so this never shows text that is already final.
 */
export function VoiceLiveTranscript(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
}) {
  const conversation = useVoiceConversation();
  const voiceThreadId = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.voiceRouterThreadId,
  );
  if (conversation?.phase !== "live" || conversation.environmentId !== props.environmentId)
    return null;
  if (conversation.realtimeTarget && props.threadId !== conversation.realtimeTarget.threadId)
    return null;
  const hearing = !conversation.heardFinal && conversation.heard.trim() !== "";
  // In the voice thread the reply is already on screen as it is written, so it is not shown twice.
  const speaking =
    !conversation.realtimeTarget && props.threadId === voiceThreadId ? null : conversation.speaking;
  if (!hearing && speaking === null) return null;
  return (
    <div
      role="status"
      aria-live="off"
      aria-label="Live voice transcript"
      className="mb-1.5 flex flex-col gap-1 rounded-md border border-dashed px-3 py-1.5 text-sm"
    >
      {speaking ? (
        <p className="min-w-0 text-secondary-label italic">
          <span className="mr-2 text-xs not-italic text-muted-foreground">
            {conversation.realtimeTarget ? "Assistant" : "Speaking"}
          </span>{" "}
          {speaking.text}
        </p>
      ) : null}
      {hearing ? (
        <p className="min-w-0 text-secondary-label italic">
          <span className="mr-2 text-xs not-italic text-muted-foreground">You</span>{" "}
          {conversation.heard}…
        </p>
      ) : null}
    </div>
  );
}
