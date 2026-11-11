import * as Schema from "effect/Schema";
import { IsoDateTime, MessageId, RunId, ThreadId } from "./baseSchemas.ts";

const MEMORY_MAX_TEXT_CHARS = 500;
/** Memories are never pruned on their own, so the store refuses new ones past this. */
export const MEMORY_LIMIT = 1_000;
const MEMORY_SEARCH_MAX_RESULTS = 20;

export const MemoryId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));
export const MemoryKind = Schema.Literals(["fact", "preference", "decision"]);
export type MemoryKind = typeof MemoryKind.Type;

/** One thing worth knowing across conversations, and where it was learned. */
export const Memory = Schema.Struct({
  id: MemoryId,
  kind: MemoryKind,
  text: Schema.String,
  threadId: ThreadId,
  messageId: Schema.NullOr(MessageId),
  runId: Schema.NullOr(RunId),
  createdAt: IsoDateTime,
});
export type Memory = typeof Memory.Type;

export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  reason: Schema.Literals(["looks-like-secret", "full", "not-voice-thread", "unavailable"]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "looks-like-secret":
        return "That looks like it contains a password, key or token, so it was not saved. Memory never holds secrets. Save what the secret is for and where it lives instead.";
      case "full":
        return `Memory is full at ${MEMORY_LIMIT} entries. Forget some that no longer matter, then try again.`;
      case "not-voice-thread":
        return "Only the thread chosen to answer voice conversations can use memory.";
      case "unavailable":
        return "Memory could not be read or changed.";
    }
  }
}

export const MemoryWriteInput = Schema.Struct({
  text: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MEMORY_MAX_TEXT_CHARS),
  ).annotate({
    description: `One self-contained sentence, at most ${MEMORY_MAX_TEXT_CHARS} characters. Never a password, key or token.`,
  }),
  kind: Schema.optional(MemoryKind).annotate({
    description: "fact (default), preference (how the user likes things), or decision.",
  }),
});
export type MemoryWriteInput = typeof MemoryWriteInput.Type;

export const MemorySearchInput = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(200)).annotate({
    description: "Words to look for. Empty returns the newest memories.",
  }),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MEMORY_SEARCH_MAX_RESULTS })),
  ),
});
export type MemorySearchInput = typeof MemorySearchInput.Type;

export const MemoryForgetInput = Schema.Struct({ id: MemoryId });
export const MemoryForgetResult = Schema.Struct({ forgotten: Schema.Boolean });
export const MemoryList = Schema.Struct({ memories: Schema.Array(Memory) });
export type MemoryList = typeof MemoryList.Type;

export const MemoryListInput = Schema.Struct({});
