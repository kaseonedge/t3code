import {
  VOICE_SAY_MAX_SENTENCES,
  VOICE_SAY_MAX_WORDS,
  type VoiceLocalCommand,
} from "@t3tools/contracts";

/** Sounds of listening. They never interrupt the bot and never reach a model. */
const FILLERS = new Set([
  "mm",
  "mhm",
  "mm hmm",
  "mmhmm",
  "uh huh",
  "hmm",
  "hm",
  "uh",
  "um",
  "ah",
  "oh",
]);
/** Agreement said over the bot's speech is listening; said into silence it answers a question. */
const AFFIRMATIONS = new Set([
  "yeah",
  "yep",
  "yes",
  "ok",
  "okay",
  "right",
  "sure",
  "i see",
  "got it",
  "cool",
]);

const COMMANDS: Readonly<Record<VoiceLocalCommand, ReadonlyArray<string>>> = {
  stop: ["stop", "stop talking", "stop it", "shut up", "enough"],
  quiet: ["quiet", "be quiet", "mute", "hold that thought"],
  resume: ["resume", "go ahead", "unmute", "you can talk"],
  repeat: [
    "repeat",
    "repeat that",
    "say that again",
    "say again",
    "pardon",
    "what did you say",
    "come again",
  ],
  louder: ["louder", "speak up", "volume up"],
  quieter: ["quieter", "softer", "volume down"],
};
const COMMAND_BY_PHRASE = new Map(
  Object.entries(COMMANDS).flatMap(([command, phrases]) =>
    phrases.map((phrase) => [phrase, command as VoiceLocalCommand] as const),
  ),
);

/** Lowercase words only, so "Mm-hmm." and "mm hmm" compare equal. */
function normalizeSpokenText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();
}

export type VoiceTurn =
  | { readonly kind: "noise" }
  | { readonly kind: "backchannel" }
  | { readonly kind: "command"; readonly command: VoiceLocalCommand }
  | { readonly kind: "utterance"; readonly text: string };

/**
 * The first stage of the two-stage filter: only an utterance costs a model call.
 * `overSpeech` says the user began this turn while the bot was talking.
 */
export function classifyVoiceTurn(text: string, overSpeech: boolean): VoiceTurn {
  const normalized = normalizeSpokenText(text);
  if (normalized.length < 2) return { kind: "noise" };
  if (FILLERS.has(normalized) || (overSpeech && AFFIRMATIONS.has(normalized)))
    return { kind: "backchannel" };
  const command = COMMAND_BY_PHRASE.get(normalized.replace(/^(please|hey) | please$/g, ""));
  if (command !== undefined) return { kind: "command", command };
  return { kind: "utterance", text: text.trim() };
}

/** Whether words heard so far are real speech that should cut the bot off. */
export function interruptsSpeech(partial: string): boolean {
  const normalized = normalizeSpokenText(partial);
  return normalized.length >= 2 && !FILLERS.has(normalized) && !AFFIRMATIONS.has(normalized);
}

/** Why `text` is too long to say aloud, or `undefined` when it fits. */
export function voiceSayLimitViolation(text: string): string | undefined {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const sentences = text.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim().length > 0).length;
  if (words <= VOICE_SAY_MAX_WORDS && sentences <= VOICE_SAY_MAX_SENTENCES) return undefined;
  return `Too long to say aloud: ${words} words in ${sentences} sentences. The limit is ${VOICE_SAY_MAX_WORDS} words in ${VOICE_SAY_MAX_SENTENCES} sentences. Nothing was spoken. Shorten it and call again.`;
}

export interface SpokenMark {
  readonly char: string;
  readonly atMs: number;
}

/** Without timings from the speech service, assume ordinary speaking pace. */
const FALLBACK_CHARS_PER_SECOND = 15;

/**
 * The words of `text` that had started playing by `playedMs`. A word cut off part way is left
 * out, so the agent never believes the user heard something they did not.
 */
export function spokenTextAt(
  text: string,
  marks: ReadonlyArray<SpokenMark>,
  playedMs: number,
): string {
  const heard =
    marks.length > 0
      ? marks
          .filter((mark) => mark.atMs < playedMs)
          .map((mark) => mark.char)
          .join("")
      : text.slice(0, Math.floor((playedMs / 1000) * FALLBACK_CHARS_PER_SECOND));
  if (heard.length >= text.length) return text.trim();
  const cutMidWord = /\S$/.test(heard) && /^\S/.test(text.slice(heard.length));
  return (cutMidWord ? heard.replace(/\S+$/, "") : heard).trim();
}
