import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useState } from "react";
import { AudioLinesIcon } from "lucide-react";

import { useClientSettings, useEnvironmentSettings } from "../../hooks/useSettings";
import {
  selectRealtimeVoiceThread,
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
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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
  const [confirmCrossThread, setConfirmCrossThread] = useState(false);
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
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
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
    : conversation?.environmentId === environmentId
      ? (conversation.error?.message ?? blocker)
      : blocker;
  const activeTarget = !elsewhere && running ? conversation?.realtimeTarget : undefined;
  const realtime =
    realtimeSupported &&
    !running &&
    threadId &&
    canTalk &&
    canRead &&
    prepared &&
    elevenLabs.apiKey !== "" &&
    elevenLabs.voiceId &&
    !elevenLabs.zeroRetention &&
    elevenLabs.serverLocation === "global" &&
    grant?.destination.environmentId === environmentId
      ? { prepared, environmentId, grantId: grant.id, microphoneId, realtimeThreadId: threadId }
      : null;

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
      {activeTarget && threadId && activeTarget.threadId !== threadId ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => selectRealtimeVoiceThread(threadId)}
        >
          Use this chat for voice
        </Button>
      ) : null}
      {realtime ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Start ElevenLabs Realtime in this thread"
            title="Start ElevenLabs Realtime in this chat. Connected time may be billed."
            onClick={() => void startVoiceConversation(realtime)}
          >
            Realtime
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setConfirmCrossThread(true)}
          >
            Realtime across chats
          </Button>
          <AlertDialog open={confirmCrossThread} onOpenChange={setConfirmCrossThread}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Start Realtime across chats?</AlertDialogTitle>
                <AlertDialogDescription>
                  On request, voice can find and read chats and queue work in this environment.
                  Relevant excerpts and results are sent to ElevenLabs. The current chat receives
                  the conversation. Connected time may be billed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                <Button
                  onClick={() => {
                    setConfirmCrossThread(false);
                    void startVoiceConversation({ ...realtime, realtimeCrossThread: true });
                  }}
                >
                  Start across chats
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </>
      ) : null}
    </>
  );
}
