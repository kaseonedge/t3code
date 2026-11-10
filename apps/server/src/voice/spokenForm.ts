/** About half a minute of speech. Longer replies are for reading, and the thread has them. */
const MAX_SPOKEN_WORDS = 80;
/** Short enough that an interruption loses little, long enough to sound like one thought. */
const MAX_CHUNK_CHARS = 220;
const REST_IN_THREAD = "The rest is in the thread.";

/**
 * A written reply as things to say aloud, in order. Markup is dropped, code is left out, and a
 * long reply is cut at a sentence with a pointer to the thread, so the bot never reads a wall of
 * text or a stack trace.
 */
export function spokenForm(text: string): ReadonlyArray<string> {
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, "$2")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain === "") return [];
  const sentences = plain.split(/(?<=[.!?…])\s+/);
  const chunks: Array<string> = [];
  let words = 0;
  for (const [index, sentence] of sentences.entries()) {
    const count = sentence.split(" ").length;
    // Always say the first sentence, however long, so a reply is never silent.
    if (index > 0 && words + count > MAX_SPOKEN_WORDS) {
      chunks.push(REST_IN_THREAD);
      break;
    }
    words += count;
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + sentence.length <= MAX_CHUNK_CHARS)
      chunks[chunks.length - 1] = `${last} ${sentence}`;
    else chunks.push(sentence);
  }
  return chunks;
}
