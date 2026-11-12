import * as Schema from "effect/Schema";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const Key = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9:_-]{1,256}$/));
const phases = ["queued", "context-accepted", "generated", "played"] as const;
const Phase = Schema.Literals(phases);
const isKey = Schema.is(Key);
const Transcript = Schema.Struct({
  id: Key,
  speaker: Schema.Literals(["user", "assistant"]),
  text: Schema.String.check(Schema.isMaxLength(500)),
});
const Operation = Schema.Struct({
  id: Key,
  phase: Phase,
  resultId: Schema.optionalKey(Key),
});
const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      expires: Schema.Finite,
      operations: Schema.Array(Operation).check(Schema.isMaxLength(24)),
      transcript: Schema.Array(Transcript).check(Schema.isMaxLength(12)),
    }),
  ),
);

function sanitize(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(
      /\b(?:api[ _-]?key|password|secret|token|authorization|bearer)\b[^.!?\n]*/gi,
      "[credential removed]",
    )
    .replace(/\b(?:sk|xi|ghp|gho|xox[baprs])[-_][\w-]+\b/gi, "[credential removed]")
    .replace(/[\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, 500);
}

export function openRealtimeConversationRecord(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  now: () => number,
) {
  let operations: Array<typeof Operation.Type> = [];
  let transcript: Array<typeof Transcript.Type> = [];
  try {
    const value = decode(storage.getItem(key));
    if (value._tag === "Some" && value.value.expires > now()) {
      operations = [...value.value.operations];
      transcript = value.value.transcript.map((entry) => ({
        ...entry,
        text: sanitize(entry.text),
      }));
    }
  } catch {
    // Private browser contexts can disable persistent storage.
  }
  const save = () => {
    try {
      storage.setItem(
        key,
        JSON.stringify({ expires: now() + RETENTION_MS, operations, transcript }),
      );
    } catch {
      // Keep the in-memory record available for the current conversation.
    }
  };
  return {
    pending: () => operations.filter((entry) => entry.phase !== "played").map(({ id }) => id),
    remember(id: string) {
      if (!isKey(id)) return false;
      if (operations.some((entry) => entry.id === id)) return true;
      if (operations.length >= 24) {
        const played = operations.find((entry) => entry.phase === "played");
        if (!played) return false;
        operations = operations.filter((entry) => entry !== played);
      }
      operations.push({ id, phase: "queued" });
      save();
      return true;
    },
    result(id: string, resultId: string, phase: typeof Phase.Type) {
      if (!isKey(resultId)) return;
      const index = operations.findIndex((entry) => entry.id === id);
      const previous = operations[index];
      if (
        !previous ||
        (previous.resultId === resultId && phases.indexOf(previous.phase) >= phases.indexOf(phase))
      )
        return;
      operations[index] = { id, resultId, phase };
      save();
    },
    transcript(id: string, speaker: (typeof Transcript.Type)["speaker"], raw: string) {
      const text = sanitize(raw);
      if (!isKey(id) || !text || transcript.some((entry) => entry.id === id)) return;
      transcript = [...transcript, { id, speaker, text }].slice(-12);
      save();
    },
    context: () => transcript.map(({ speaker, text }) => ({ speaker, text })),
  };
}

export type RealtimeConversationRecord = ReturnType<typeof openRealtimeConversationRecord>;
