import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Long-term memory for the voice thread. `seq` is the search index's row id; an explicit integer
 * key keeps it stable across VACUUM, so the index never needs rebuilding.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE memories (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT,
      run_id TEXT,
      created_at TEXT NOT NULL
    )
  `;
  // An SQLite build without FTS5 still gets memory; search scans instead. Only SQLITE_ERROR
  // means "unsupported". Disk and I/O failures must fail the migration so startup retries it.
  const indexed = yield* sql`
    CREATE VIRTUAL TABLE memories_search USING fts5(
      text,
      content = 'memories',
      content_rowid = 'seq',
      tokenize = 'porter unicode61 remove_diacritics 1'
    )
  `.pipe(
    Effect.as(true),
    Effect.catchIf(
      (cause) =>
        Predicate.hasProperty(cause.reason.cause, "errcode") && cause.reason.cause.errcode === 1,
      (cause) =>
        Effect.logWarning(
          "Memory search index unavailable; search will scan memories.",
          cause,
        ).pipe(Effect.as(false)),
    ),
  );
  if (!indexed) return;
  yield* sql`
    CREATE TRIGGER memories_search_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_search (rowid, text) VALUES (new.seq, new.text);
    END
  `;
  yield* sql`
    CREATE TRIGGER memories_search_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_search (memories_search, rowid, text)
      VALUES ('delete', old.seq, old.text);
    END
  `;
});
