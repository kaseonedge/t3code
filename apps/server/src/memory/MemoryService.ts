import {
  MEMORY_LIMIT,
  Memory,
  MemoryError,
  type MemoryList,
  type MemorySearchInput,
  type MemoryWriteInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { looksLikeSecret } from "./secretFilter.ts";

const MAX_QUERY_TERMS = 12;
/** Words that match nearly every memory and so say nothing about relevance. */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "for",
  "and",
  "or",
  "is",
  "it",
  "that",
  "this",
  "was",
  "we",
  "i",
  "my",
  "from",
  "with",
  "about",
  "what",
  "did",
]);

/** The distinct words of `query` worth searching for. */
function memoryQueryTerms(query: string): ReadonlyArray<string> {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(words.filter((word) => !STOP_WORDS.has(word)))].slice(0, MAX_QUERY_TERMS);
}

const encodeTerms = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export class MemoryService extends Context.Service<
  MemoryService,
  {
    /** Saves a memory for the voice thread, stamped with the thread, run and message it came from. */
    readonly remember: (
      caller: ThreadId,
      input: MemoryWriteInput,
    ) => Effect.Effect<Memory, MemoryError>;
    /** The best matches first; with no usable words, the newest. */
    readonly recall: (
      caller: ThreadId,
      input: MemorySearchInput,
    ) => Effect.Effect<MemoryList, MemoryError>;
    readonly forgetAs: (caller: ThreadId, id: string) => Effect.Effect<boolean, MemoryError>;
    /** Everything remembered, newest first, for the person who owns the environment. */
    readonly list: Effect.Effect<MemoryList, MemoryError>;
    readonly forget: (id: string) => Effect.Effect<boolean, MemoryError>;
  }
>()("t3/memory/MemoryService") {}

const columns = (sql: SqlClient.SqlClient) => sql`
  memories.id AS "id",
  memories.kind AS "kind",
  memories.text AS "text",
  memories.thread_id AS "threadId",
  memories.message_id AS "messageId",
  memories.run_id AS "runId",
  memories.created_at AS "createdAt"
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const unavailable = () => new MemoryError({ reason: "unavailable" });
  const indexed = yield* sql`
    SELECT 1 FROM sqlite_master WHERE name = 'memories_search'
  `.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.orElseSucceed(() => false),
  );

  const requireVoiceThread = (caller: ThreadId) =>
    settings.getSettings.pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((current) =>
        current.voiceRouterThreadId === caller
          ? Effect.void
          : Effect.fail(new MemoryError({ reason: "not-voice-thread" })),
      ),
    );

  const newest = SqlSchema.findAll({
    Request: Schema.Int,
    Result: Memory,
    execute: (limit) =>
      sql`SELECT ${columns(sql)} FROM memories ORDER BY memories.seq DESC LIMIT ${limit}`,
  });
  const ranked = SqlSchema.findAll({
    Request: Schema.Struct({ match: Schema.String, limit: Schema.Int }),
    Result: Memory,
    // bm25 puts the memories that share the most, and the rarest, words first.
    execute: ({ match, limit }) => sql`
      SELECT ${columns(sql)}
      FROM memories_search
      INNER JOIN memories ON memories.seq = memories_search.rowid
      WHERE memories_search MATCH ${match}
      ORDER BY bm25(memories_search), memories.seq DESC
      LIMIT ${limit}
    `,
  });
  const scanned = SqlSchema.findAll({
    Request: Schema.Struct({ terms: Schema.String, limit: Schema.Int }),
    Result: Memory,
    execute: ({ terms, limit }) => sql`
      SELECT ${columns(sql)}
      FROM memories
      WHERE EXISTS (
        SELECT 1 FROM json_each(${terms}) AS term
        WHERE instr(lower(memories.text), term.value) > 0
      )
      ORDER BY memories.seq DESC
      LIMIT ${limit}
    `,
  });

  const search = Effect.fn("MemoryService.search")(function* (input: MemorySearchInput) {
    const limit = input.limit ?? 8;
    const terms = memoryQueryTerms(input.query);
    if (terms.length === 0) return yield* newest(limit);
    if (!indexed) return yield* scanned({ terms: encodeTerms(terms), limit });
    return yield* ranked({ match: terms.map((term) => `"${term}"`).join(" OR "), limit });
  });

  const remove = (id: string) =>
    sql`DELETE FROM memories WHERE id = ${id} RETURNING id`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(unavailable),
    );

  const remember: MemoryService["Service"]["remember"] = Effect.fn("MemoryService.remember")(
    function* (caller, input) {
      yield* requireVoiceThread(caller);
      const text = input.text.trim();
      if (looksLikeSecret(text)) return yield* new MemoryError({ reason: "looks-like-secret" });
      const { runs } = yield* projections
        .getThreadRecords(caller, ["runs"])
        .pipe(Effect.mapError(unavailable));
      const run = runs
        .filter((candidate) => candidate.status === "running")
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      const memory: Memory = {
        id: `memory:${yield* random.uuidV4()}`,
        kind: input.kind ?? "fact",
        text,
        threadId: caller,
        messageId: run?.userMessageId ?? null,
        runId: run?.id ?? null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      // One statement, so two writers cannot both pass the limit.
      const saved = yield* sql`
        INSERT INTO memories (id, kind, text, thread_id, message_id, run_id, created_at)
        SELECT ${memory.id}, ${memory.kind}, ${memory.text}, ${memory.threadId},
          ${memory.messageId}, ${memory.runId}, ${memory.createdAt}
        WHERE (SELECT count(*) FROM memories) < ${MEMORY_LIMIT}
        RETURNING id
      `.pipe(Effect.mapError(unavailable));
      if (saved.length === 0) return yield* new MemoryError({ reason: "full" });
      return memory;
    },
  );

  return MemoryService.of({
    remember,
    recall: Effect.fn("MemoryService.recall")(function* (caller, input) {
      yield* requireVoiceThread(caller);
      return { memories: yield* search(input).pipe(Effect.mapError(unavailable)) };
    }),
    forgetAs: Effect.fn("MemoryService.forgetAs")(function* (caller, id) {
      yield* requireVoiceThread(caller);
      return yield* remove(id);
    }),
    list: newest(MEMORY_LIMIT).pipe(
      Effect.map((memories) => ({ memories })),
      Effect.mapError(unavailable),
    ),
    forget: remove,
  });
});

export const layer = Layer.effect(MemoryService, make);
