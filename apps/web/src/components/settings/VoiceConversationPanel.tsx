import { MicIcon, MicOffIcon } from "lucide-react";

import type { VoiceConversationSnapshot } from "../../speech/voiceConversation";
import { voiceConversationStatus } from "../../speech/voiceConversationStatus";
import { Button } from "../ui/button";

const TONE_CLASS = {
  idle: "bg-muted-foreground/50",
  live: "bg-success",
  attention: "bg-warning",
  error: "bg-destructive",
} as const;

/** State of the live conversation. Indicators are static: nothing here repaints on a timer. */
export function VoiceConversationPanel(props: {
  readonly snapshot: VoiceConversationSnapshot | null;
  readonly onStart?: (() => void) | undefined;
  readonly startDisabledReason?: string | undefined;
  readonly onStop: () => void;
}) {
  const status = voiceConversationStatus(props.snapshot);
  const running = props.snapshot?.phase === "connecting" || props.snapshot?.phase === "live";
  return (
    <div className="flex min-w-0 items-center gap-2" role="status" aria-label="Voice conversation">
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${TONE_CLASS[status.tone]}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{status.label}</p>
        {props.snapshot?.realtimeTarget ? (
          <p className="truncate text-xs text-muted-foreground">
            {props.snapshot.realtimeTarget.title} ·{" "}
            {props.snapshot.realtimeTarget.crossThread ? "This environment" : "Selected chat"}
          </p>
        ) : null}
        {status.detail || props.startDisabledReason ? (
          <p className="truncate text-xs text-muted-foreground">
            {status.detail || (running ? "" : props.startDisabledReason)}
          </p>
        ) : null}
      </div>
      {running ? (
        <Button type="button" size="xs" variant="outline" onClick={props.onStop}>
          <MicOffIcon />
          End
        </Button>
      ) : props.snapshot?.phase === "failed" && !props.onStart ? (
        <Button type="button" size="xs" variant="outline" onClick={props.onStop}>
          Dismiss
        </Button>
      ) : props.onStart ? (
        <Button
          type="button"
          size="xs"
          disabled={props.startDisabledReason !== undefined}
          onClick={props.onStart}
        >
          <MicIcon />
          Start
        </Button>
      ) : null}
    </div>
  );
}
