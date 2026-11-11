import { type EnvironmentId, VoiceConversationGrant } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  readLocalStorageValue,
  useLocalStorage,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";
import { randomUUID } from "../lib/utils";

// Its own key: consent to dictation never starts a conversation, and the reverse.
const GRANT_KEY = "t3code:voice-conversation-grant:v1";
const ACKNOWLEDGEMENT_KEY = "t3code:voice-conversation-acknowledgement:v1";
const Grant = Schema.NullOr(VoiceConversationGrant);

export const VoiceAcknowledgement = Schema.Literals(["sound", "visual", "off"]);
export type VoiceAcknowledgement = typeof VoiceAcknowledgement.Type;

export function useVoiceConversationGrant() {
  return useLocalStorage(GRANT_KEY, null, Grant)[0];
}

/** Records this act of consent to send the microphone through `environmentId` to ElevenLabs. */
export function grantVoiceConversation(environmentId: EnvironmentId) {
  writeLocalStorageValue(
    GRANT_KEY,
    { id: randomUUID(), destination: { kind: "elevenlabs", environmentId } },
    null,
    Grant,
  );
}

export function revokeVoiceConversation() {
  writeLocalStorageValue(GRANT_KEY, null, null, Grant);
}

/** True while the grant a conversation started under is still the one in force. */
export function bindVoiceConversationGrant(id: string, environmentId: EnvironmentId) {
  return () => {
    try {
      const grant = readLocalStorageValue(GRANT_KEY, null, Grant);
      return grant?.id === id && grant.destination.environmentId === environmentId;
    } catch {
      return false;
    }
  };
}

export function useVoiceAcknowledgement() {
  return useLocalStorage(ACKNOWLEDGEMENT_KEY, "sound", VoiceAcknowledgement)[0];
}
export function readVoiceAcknowledgement() {
  return readLocalStorageValue(ACKNOWLEDGEMENT_KEY, "sound", VoiceAcknowledgement);
}
export function chooseVoiceAcknowledgement(mode: VoiceAcknowledgement) {
  writeLocalStorageValue(ACKNOWLEDGEMENT_KEY, mode, "sound", VoiceAcknowledgement);
}
