import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("041_ProjectionSubagents", (it) => {
  it.effect("creates the projection table and ordered parent index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type='table' AND name='projection_subagents'`;
      const indexes = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projection_subagents_parent_thread_created'`;
      assert.lengthOf(tables, 1);
      assert.lengthOf(indexes, 1);
    }),
  );
});
