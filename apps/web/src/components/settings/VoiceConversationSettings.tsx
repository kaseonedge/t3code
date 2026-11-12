import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  ElevenLabsVoiceId,
  type EnvironmentId,
  isSecretReference,
  type SecretReference,
  type ServerSettingsPatch,
  type ThreadId,
  VOICE_WATCH_LIMIT,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";

import {
  useClientSettings,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../hooks/useSettings";
import {
  startVoiceConversation,
  stopVoiceConversation,
  useVoiceConversation,
} from "../../speech/voiceConversation";
import {
  chooseVoiceAcknowledgement,
  grantVoiceConversation,
  revokeVoiceConversation,
  useVoiceAcknowledgement,
  type VoiceAcknowledgement,
  useVoiceConversationGrant,
} from "../../speech/voiceConversationConsent";
import { useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { MemorySettings } from "./MemorySettings";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { voiceConversationBlocker } from "../../speech/voiceConversationStatus";
import { VoiceConversationPanel } from "./VoiceConversationPanel";

const NO_THREAD = "none";
const isVoiceId = Schema.is(ElevenLabsVoiceId);
// Model ids as ElevenLabs publishes them. Flash stays the default until v4 Turbo has been heard.
const SPEECH_MODEL_LABELS: Readonly<Record<string, string>> = {
  eleven_flash_v2_5: "Flash v2.5",
  eleven_v4_turbo: "v4 Turbo",
};
const ACKNOWLEDGEMENT_LABELS: Record<VoiceAcknowledgement, string> = {
  sound: "Short tone",
  visual: "On screen only",
  off: "None",
};

function EnvironmentVoiceConversation({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const elevenLabs = useEnvironmentSettings(environmentId, (settings) => settings.elevenLabs);
  const voiceThreadId = useEnvironmentSettings(
    environmentId,
    (settings) => settings.voiceRouterThreadId,
  );
  const update = useUpdateEnvironmentSettings(environmentId);
  const save = (patch: ServerSettingsPatch) => void update(patch);
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canTalk = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const sources = useSecretSources(environmentId);
  const threads = useThreadShells().filter((thread) => thread.environmentId === environmentId);
  const grant = useVoiceConversationGrant();
  const consented = grant?.destination.environmentId === environmentId;
  const acknowledgement = useVoiceAcknowledgement();
  const microphoneId = useClientSettings().voiceMicrophone;
  const snapshot = useVoiceConversation();
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>(
    isSecretReference(elevenLabs.apiKey) ? elevenLabs.apiKey : "",
  );
  const keySaved = isSecretReference(elevenLabs.apiKey) || elevenLabs.apiKey !== "";
  const voiceThread = threads.find((thread) => thread.id === voiceThreadId);
  const watchedIds = useEnvironmentSettings(
    environmentId,
    (settings) => settings.voiceWatchedThreadIds,
  );
  const watchdogThreadId = useEnvironmentSettings(
    environmentId,
    (settings) => settings.voiceWatchdogThreadId,
  );
  const announceAll = useEnvironmentSettings(
    environmentId,
    (settings) => settings.voiceAnnounceAllThreads,
  );
  const watchable = threads.filter(
    (thread) => thread.id !== voiceThreadId && !watchedIds.includes(thread.id),
  );
  const blocker = voiceConversationBlocker({
    connected: prepared !== null && canTalk,
    keySaved,
    voiceId: elevenLabs.voiceId,
    voiceThreadId,
    consented,
  });

  return (
    <>
      <SettingsRow
        {...searchableSetting("voice-conversation")}
        title="Voice conversation"
        description={`Talk with one thread on ${environmentLabel} and hear it answer. You can interrupt it at any time, and it can speak when work finishes.`}
        control={
          <VoiceConversationPanel
            snapshot={snapshot?.environmentId === environmentId ? snapshot : null}
            startDisabledReason={blocker}
            onStart={() => {
              if (prepared && grant)
                void startVoiceConversation({
                  prepared,
                  environmentId,
                  grantId: grant.id,
                  microphoneId,
                });
            }}
            onStop={stopVoiceConversation}
          />
        }
      />
      <SettingsRow
        title="ElevenLabs API key"
        description={`Saved on ${environmentLabel} and never shown again. Anyone who can talk to this environment can bill this key.`}
        control={
          <div className="flex min-w-0 max-w-80 items-start gap-1.5">
            <SecretSourceInput
              aria-label="ElevenLabs API key"
              size="sm"
              value={keyDraft}
              sources={sources}
              configured={keySaved && !isSecretReference(elevenLabs.apiKey)}
              disabled={!canManage}
              onCommit={(next) => {
                setKeyDraft("");
                if (next.trim()) save({ elevenLabs: { apiKey: next.trim() } });
              }}
              onSecretChange={(secret) => {
                setKeyDraft(secret ?? "");
                save({ elevenLabs: { apiKey: secret ?? "" } });
              }}
            />
            {keySaved ? (
              <Button
                type="button"
                size="xs"
                variant="ghost-destructive"
                disabled={!canManage}
                onClick={() => {
                  setKeyDraft("");
                  save({ elevenLabs: { apiKey: "" } });
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        title="Voice"
        description="The ElevenLabs voice ID the bot speaks with. Copy it from your ElevenLabs voice library."
        control={
          <DraftInput
            aria-label="ElevenLabs voice ID"
            size="sm"
            font="mono"
            className="max-w-64"
            placeholder="Voice ID"
            value={elevenLabs.voiceId}
            disabled={!canManage}
            spellCheck={false}
            onCommit={(next) => {
              const voiceId = next.trim();
              if (voiceId === "" || isVoiceId(voiceId)) save({ elevenLabs: { voiceId } });
            }}
          />
        }
      />
      <SettingsRow
        title="Speech model"
        description="The ElevenLabs model the bot speaks with. Flash is the fastest and cheapest. v4 Turbo sounds more natural and costs more per character; your ElevenLabs plan must include it."
        control={
          <Select
            value={elevenLabs.textToSpeechModel}
            disabled={!canManage}
            onValueChange={(value) => {
              if (value) save({ elevenLabs: { textToSpeechModel: value } });
            }}
          >
            <SelectTrigger size="sm" aria-label="Speech model" className="max-w-56">
              <SelectValue>
                {SPEECH_MODEL_LABELS[elevenLabs.textToSpeechModel] ?? elevenLabs.textToSpeechModel}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(SPEECH_MODEL_LABELS).map(([model, label]) => (
                <SelectItem key={model} value={model}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Voice thread"
        description="The one thread that hears you and answers aloud. It hands longer work to other threads and tells you when they finish."
        control={
          <Select
            value={voiceThreadId ?? NO_THREAD}
            disabled={!canManage}
            onValueChange={(value) => {
              if (value)
                save({ voiceRouterThreadId: value === NO_THREAD ? null : (value as ThreadId) });
            }}
          >
            <SelectTrigger size="sm" aria-label="Voice thread" className="max-w-72">
              <SelectValue>
                {voiceThreadId === null ? "None" : (voiceThread?.title ?? "Unavailable thread")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={NO_THREAD}>None</SelectItem>
              {threads.map((thread) => (
                <SelectItem key={thread.id} value={thread.id}>
                  {thread.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Report thread activity"
        description="Reports finished work and requests for your input in this environment, including side chats and linked task results. Each report uses a model turn. Turn off to report only watched work."
        control={
          <Switch
            aria-label="Report thread activity"
            checked={announceAll}
            disabled={!canManage}
            onCheckedChange={(voiceAnnounceAllThreads) => save({ voiceAnnounceAllThreads })}
          />
        }
      />
      <SettingsRow
        title="Watched threads"
        description={`These report to the voice thread even when thread activity reports are off. The voice thread gets its own delegated task results separately. Up to ${VOICE_WATCH_LIMIT}.`}
        control={
          <Select
            value={null}
            disabled={
              !canManage || watchedIds.length >= VOICE_WATCH_LIMIT || watchable.length === 0
            }
            onValueChange={(value) => {
              if (value) save({ voiceWatchedThreadIds: [...watchedIds, value as ThreadId] });
            }}
          >
            <SelectTrigger size="sm" aria-label="Watch a thread" className="max-w-48">
              <SelectValue>Watch a thread</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {watchable.map((thread) => (
                <SelectItem key={thread.id} value={thread.id}>
                  {thread.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      >
        {watchedIds.length > 0 ? (
          <ul className="flex flex-col gap-1 px-4 pb-3">
            {watchedIds.map((id) => (
              <li key={id} className="flex min-w-0 items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {threads.find((thread) => thread.id === id)?.title ?? "Unavailable thread"}
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Stop watching this thread"
                  disabled={!canManage}
                  onClick={() =>
                    save({ voiceWatchedThreadIds: watchedIds.filter((watched) => watched !== id) })
                  }
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Watchdog thread"
        description="A thread that may check on the voice thread and its workers and report what is stuck. It does nothing by itself: add a scheduled task that asks it to check, as the voice conversation guide describes."
        control={
          <Select
            value={watchdogThreadId ?? NO_THREAD}
            disabled={!canManage}
            onValueChange={(value) => {
              if (value)
                save({ voiceWatchdogThreadId: value === NO_THREAD ? null : (value as ThreadId) });
            }}
          >
            <SelectTrigger size="sm" aria-label="Watchdog thread" className="max-w-72">
              <SelectValue>
                {watchdogThreadId === null
                  ? "None"
                  : (threads.find((thread) => thread.id === watchdogThreadId)?.title ??
                    "Unavailable thread")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={NO_THREAD}>None</SelectItem>
              {threads
                .filter((thread) => thread.id !== voiceThreadId)
                .map((thread) => (
                  <SelectItem key={thread.id} value={thread.id}>
                    {thread.title}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Allow on this device"
        description={`While a conversation is on, this device's microphone is sent through ${environmentLabel} to ElevenLabs, and what the bot says comes back the same way. Turning this off ends a running conversation.`}
        control={
          <Switch
            aria-label="Allow voice conversations on this device"
            checked={consented}
            onCheckedChange={(checked) =>
              checked ? grantVoiceConversation(environmentId) : revokeVoiceConversation()
            }
          />
        }
      />
      <SettingsRow
        title="Zero retention"
        description="Ask ElevenLabs not to keep audio or text. Only some ElevenLabs plans allow this; on others the conversation stops instead of continuing with retention on."
        control={
          <Switch
            aria-label="Zero retention"
            checked={elevenLabs.zeroRetention}
            disabled={!canManage}
            onCheckedChange={(zeroRetention) => save({ elevenLabs: { zeroRetention } })}
          />
        }
      />
      <SettingsRow
        title="When your turn is heard"
        description="How this device shows that the bot heard you, before it has an answer."
        control={
          <Select
            value={acknowledgement}
            onValueChange={(value) => {
              if (value) chooseVoiceAcknowledgement(value as VoiceAcknowledgement);
            }}
          >
            <SelectTrigger size="sm" aria-label="Acknowledgement" className="max-w-48">
              <SelectValue>{ACKNOWLEDGEMENT_LABELS[acknowledgement]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(ACKNOWLEDGEMENT_LABELS) as VoiceAcknowledgement[]).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {ACKNOWLEDGEMENT_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <MemorySettings environmentId={environmentId} environmentLabel={environmentLabel} />
    </>
  );
}

/** Settings → Voice → Conversation. Hidden when no connected environment can hold one. */
export function VoiceConversationSettings() {
  const { environments } = useEnvironments();
  const capable = environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.voiceConversation,
  );
  const grant = useVoiceConversationGrant();
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const environment =
    capable.find((candidate) => candidate.environmentId === chosen) ??
    capable.find((candidate) => candidate.environmentId === grant?.destination.environmentId) ??
    capable[0];
  if (!environment) return null;
  return (
    <SettingsSection
      id="voice-conversation-section"
      title="Conversation"
      headerAction={
        capable.length > 1 ? (
          <Select
            value={environment.environmentId}
            onValueChange={(value) => {
              if (value) setChosen(value as EnvironmentId);
            }}
          >
            <SelectTrigger size="sm" aria-label="Conversation environment">
              <SelectValue>{environment.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {capable.map((candidate) => (
                <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                  {candidate.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : undefined
      }
    >
      <EnvironmentVoiceConversation
        key={environment.environmentId}
        environmentId={environment.environmentId}
        environmentLabel={environment.label}
      />
    </SettingsSection>
  );
}
