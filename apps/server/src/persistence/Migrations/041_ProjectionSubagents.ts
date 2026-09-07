import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_subagents (
      subagent_id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      subagent_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_subagents_parent_thread_created
    ON projection_subagents(parent_thread_id, created_at, subagent_id)
  `;
});
