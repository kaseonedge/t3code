import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AudioLinesIcon } from "lucide-react";

import { useClientSettings, useEnvironmentSettings } from "../../hooks/useSettings";
import {
  startVoiceConversation,
  stopVoiceConversation,
  useVoiceConversation,
} from "../../speech/voiceConversation";
import { useVoiceConversationGrant } from "../../speech/voiceConversationConsent";
import {
  voiceConversationBlocker,
  voiceConversationStatus,
} from "../../speech/voiceConversationStatus";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Turns the live voice conversation on and off from the composer. It sits beside dictation and
 * shares nothing with it: dictation fills the draft, this talks with the voice thread.
 */
export function ComposerVoiceConversationButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId | undefined;
}) {
  const { environmentId, threadId } = props;
  const navigate = useNavigate();
  const supported = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.voiceConversation === true,
  );
  const realtimeSupported = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.voiceRealtime === true,
  );
  const elevenLabs = useEnvironmentSettings(environmentId, (settings) => settings.elevenLabs);
  const voiceThreadId = useEnvironmentSettings(
    environmentId,
    (settings) => settings.voiceRouterThreadId,
  );
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canTalk = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const grant = useVoiceConversationGrant();
  const microphoneId = useClientSettings().voiceMicrophone;
  const conversation = useVoiceConversation();
  if (!supported) return null;

  const running = conversation?.phase === "connecting" || conversation?.phase === "live";
  // One conversation per window: while it runs elsewhere, this composer cannot start another.
  const elsewhere = running && conversation.environmentId !== environmentId;
  const blocker = voiceConversationBlocker({
    connected: prepared !== null && canTalk,
    keySaved: elevenLabs.apiKey !== "",
    voiceId: elevenLabs.voiceId,
    voiceThreadId,
    consented: grant?.destination.environmentId === environmentId,
  });
  const label = running
    ? "End voice conversation"
    : blocker === undefined
      ? "Start voice conversation"
      : "Set up voice conversation";
  const detail = running
    ? elsewhere
      ? "Running on another environment"
      : voiceConversationStatus(conversation).label
    : blocker;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant={running ? "default" : "ghost"}
              aria-label={label}
              aria-pressed={running}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                if (running) return stopVoiceConversation();
                // Nothing is granted or saved from here: setup and consent stay in Settings.
                if (blocker !== undefined || prepared === null || !grant)
                  return void navigate({
                    to: "/settings/voice",
                    hash: "voice-conversation-section",
                  });
                void startVoiceConversation({
                  prepared,
                  environmentId,
                  grantId: grant.id,
                  microphoneId,
                });
              }}
              className="relative shrink-0"
            >
              <AudioLinesIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          {label}
          {detail ? ` · ${detail}` : ""}
        </TooltipPopup>
      </Tooltip>
      {realtimeSupported &&
      !running &&
      threadId &&
      canTalk &&
      prepared &&
      elevenLabs.apiKey !== "" &&
      elevenLabs.voiceId &&
      !elevenLabs.zeroRetention &&
      elevenLabs.serverLocation === "global" &&
      grant?.destination.environmentId === environmentId ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Start ElevenLabs Realtime in this thread"
          title="Start ElevenLabs Realtime in this thread. Connected time may be billed."
          onClick={() =>
            void startVoiceConversation({
              prepared,
              environmentId,
              grantId: grant.id,
              microphoneId,
              realtimeThreadId: threadId,
            })
          }
        >
          Realtime
        </Button>
      ) : null}
    </>
  );
}
