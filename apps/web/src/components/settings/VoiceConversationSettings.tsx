import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  ElevenLabsVoiceId,
  type EnvironmentId,
  isSecretReference,
  type SecretReference,
  type ServerSettingsPatch,
  type ThreadId,
} from "@t3tools/contracts";
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
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { voiceConversationBlocker } from "../../speech/voiceConversationStatus";
import { VoiceConversationPanel } from "./VoiceConversationPanel";

const NO_THREAD = "none";
const isVoiceId = Schema.is(ElevenLabsVoiceId);
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
