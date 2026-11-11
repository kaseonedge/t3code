import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { MEMORY_LIMIT, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MemoryService from "./MemoryService.ts";

const router = ThreadId.make("thread:voice-router");
const run = {
  id: RunId.make("run:1"),
  status: "running",
  ordinal: 1,
  userMessageId: MessageId.make("message:1"),
};

const layerDatabase = NodeSqliteClient.layer({ filename: ":memory:" });
// Migrations run before the service looks for its search index, as they do at startup.
const layerMigrated = Layer.effectDiscard(runMigrations()).pipe(Layer.provideMerge(layerDatabase));
const layerTest = MemoryService.layer.pipe(
  Layer.provide(ServerSettings.ServerSettingsService.layerTest({ voiceRouterThreadId: router })),
  Layer.provide(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: () => Effect.succeed({ runs: [run] } as never),
    }),
  ),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(layerMigrated),
);

it.layer(layerTest)("MemoryService", (it) => {
  it.effect("the migration builds the table and an index that follows inserts and deletes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const names = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE name LIKE 'memories%' AND type IN ('table', 'trigger')
        ORDER BY name
      `;
      assert.includeMembers(
        names.map(({ name }) => name),
        ["memories", "memories_search", "memories_search_delete", "memories_search_insert"],
      );
      const memory = yield* MemoryService.MemoryService;
      const saved = yield* memory.remember(router, {
        text: "The zebra crossing demo is on Friday.",
      });
      const hits = sql<{ readonly rowid: number }>`
        SELECT rowid FROM memories_search WHERE memories_search MATCH 'zebra'
      `;
      assert.lengthOf(yield* hits, 1);
      assert.isTrue(yield* memory.forget(saved.id));
      assert.lengthOf(yield* hits, 0);
      assert.isFalse(yield* memory.forget(saved.id));
    }),
  );

  it.effect("every memory records the thread, run and message it came from", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      const saved = yield* memory.remember(router, {
        text: "  Simon prefers squash merges.  ",
        kind: "preference",
      });
      assert.deepInclude(saved, {
        kind: "preference",
        text: "Simon prefers squash merges.",
        threadId: router,
        runId: run.id,
        messageId: run.userMessageId,
      });
      assert.deepInclude((yield* memory.list).memories, saved);
      yield* memory.forget(saved.id);
    }),
  );

  it.effect("ranks the memory sharing the most query words first, and finds word variants", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      const texts = [
        "The auth service token refresh bug was fixed on Tuesday in the login thread.",
        "Tuesday standup moved to ten.",
        "The billing export runs nightly.",
      ];
      const saved = yield* Effect.forEach(texts, (text) => memory.remember(router, { text }));
      const found = yield* memory.recall(router, { query: "that auth thing from Tuesday" });
      assert.deepEqual(
        found.memories.map(({ text }) => text),
        [texts[0], texts[1]],
      );
      // Stemming: "fixing" finds "fixed"; unrelated words find nothing.
      assert.lengthOf((yield* memory.recall(router, { query: "fixing" })).memories, 1);
      assert.lengthOf((yield* memory.recall(router, { query: "kubernetes" })).memories, 0);
      // No usable words: the newest, newest first, within the limit.
      const newest = yield* memory.recall(router, { query: "the", limit: 2 });
      assert.deepEqual(
        newest.memories.map(({ text }) => text),
        [texts[2], texts[1]],
      );
      // Search syntax in a query is text, not an instruction to the index.
      assert.lengthOf((yield* memory.recall(router, { query: 'auth" OR text:*' })).memories, 1);
      yield* Effect.forEach(saved, ({ id }) => memory.forget(id));
    }),
  );

  it.effect("refuses secrets, other threads, and writes past the limit", () =>
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      const sql = yield* SqlClient.SqlClient;
      const reason = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
        Effect.flip(effect).pipe(Effect.map((error) => error.reason));
      assert.equal(
        yield* reason(memory.remember(router, { text: "The wifi password is hunter2rocks" })),
        "looks-like-secret",
      );
      const worker = ThreadId.make("thread:worker");
      assert.equal(yield* reason(memory.remember(worker, { text: "A fact." })), "not-voice-thread");
      assert.equal(yield* reason(memory.recall(worker, { query: "fact" })), "not-voice-thread");
      assert.equal(yield* reason(memory.forgetAs(worker, "memory:1")), "not-voice-thread");
      assert.lengthOf((yield* memory.list).memories, 0);

      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MEMORY_LIMIT})
        INSERT INTO memories (id, kind, text, thread_id, created_at)
        SELECT 'memory:fill-' || i, 'fact', 'filler ' || i, ${router}, '2026-01-01T00:00:00.000Z' FROM n
      `;
      assert.equal(yield* reason(memory.remember(router, { text: "One too many." })), "full");
      assert.isTrue(yield* memory.forgetAs(router, "memory:fill-1"));
      yield* memory.remember(router, { text: "Now there is room." });
    }),
  );
});
