/** Credential formats that are recognizable on sight. */
const KNOWN_SHAPES: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

/** "the password is hunter2", "STAGING_API_KEY=abc123": a secret word given a value. */
const ASSIGNMENT =
  /(?<![A-Za-z])(?:pass(?:word|phrase|code)?|passwd|pwd|secret|token|api[\s_-]?key|access[\s_-]?key|private[\s_-]?key|credential|pin)s?(?![A-Za-z])\s*(?:is|was|[:=])\s*["'`]?(\S{4,})/i;
/** Values after a secret word that describe a secret without being one. */
const DESCRIBES =
  /^(?:in|on|at|kept|stored|saved|the|a|an|not|no|his|her|their|my|your|rotated|expired|required|needed|missing|set|managed|shared|same|different|unknown|there|here|with|from|for|that|this|it)\b/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A long run of mixed characters with no words in it, as generated keys are. */
function looksGenerated(token: string): boolean {
  if (token.length < 32 || !/^[A-Za-z0-9+/_=-]+$/.test(token) || UUID.test(token)) return false;
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) return false;
  const counts = new Map<string, number>();
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const share = count / token.length;
    entropy -= share * Math.log2(share);
  }
  return entropy >= 3.5;
}

/**
 * Whether `text` appears to carry a credential. Memory is read back into agent context and shown
 * in Settings, so it errs toward refusing: a false alarm costs a rephrase, a miss leaks a key.
 */
export function looksLikeSecret(text: string): boolean {
  if (KNOWN_SHAPES.some((shape) => shape.test(text))) return true;
  const assigned = ASSIGNMENT.exec(text)?.[1];
  if (assigned !== undefined && !DESCRIBES.test(assigned)) return true;
  return text.split(/[\s"'`,;()<>[\]{}]+/).some(looksGenerated);
}
