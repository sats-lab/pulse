import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { PulseSubagent } from "@t3tools/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionSubagentRepository,
  type ProjectionSubagentRepositoryShape,
  GetProjectionSubagentInput,
  ListProjectionSubagentsInput,
} from "../Services/ProjectionSubagents.ts";

const Row = Schema.Struct({
  subagentId: Schema.String,
  parentThreadId: Schema.String,
  subagent: Schema.fromJsonString(PulseSubagent),
  createdAt: Schema.String,
});
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const upsertRow = SqlSchema.void({
    Request: PulseSubagent,
    execute: (s) =>
      sql`INSERT INTO projection_subagents (subagent_id,parent_thread_id,subagent_json,created_at) VALUES (${s.id},${s.origin.threadId},${JSON.stringify(s)},${s.createdAt}) ON CONFLICT(subagent_id) DO UPDATE SET parent_thread_id=excluded.parent_thread_id,subagent_json=excluded.subagent_json,created_at=excluded.created_at`,
  });
  const getRow = SqlSchema.findOneOption({
    Request: GetProjectionSubagentInput,
    Result: Row,
    execute: ({ subagentId }) =>
      sql`SELECT subagent_id AS "subagentId", parent_thread_id AS "parentThreadId", subagent_json AS "subagent", created_at AS "createdAt" FROM projection_subagents WHERE subagent_id=${subagentId}`,
  });
  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Row,
    execute: () =>
      sql`SELECT subagent_id AS "subagentId", parent_thread_id AS "parentThreadId", subagent_json AS "subagent", created_at AS "createdAt" FROM projection_subagents ORDER BY created_at ASC, subagent_id ASC`,
  });
  const listRows = SqlSchema.findAll({
    Request: ListProjectionSubagentsInput,
    Result: Row,
    execute: ({ threadId }) =>
      sql`SELECT subagent_id AS "subagentId", parent_thread_id AS "parentThreadId", subagent_json AS "subagent", created_at AS "createdAt" FROM projection_subagents WHERE parent_thread_id=${threadId} ORDER BY created_at ASC, subagent_id ASC`,
  });
  const mapError = (operation: string) => toPersistenceSqlError(operation);
  return {
    upsert: (s) =>
      upsertRow(s).pipe(Effect.mapError(mapError("ProjectionSubagentRepository.upsert:query"))),
    getById: (i) =>
      getRow(i).pipe(
        Effect.mapError(mapError("ProjectionSubagentRepository.getById:query")),
        Effect.map(Option.map((r) => r.subagent)),
      ),
    listAll: () =>
      listAllRows(undefined).pipe(
        Effect.mapError(mapError("ProjectionSubagentRepository.listAll:query")),
        Effect.map((rows) => rows.map((r) => r.subagent)),
      ),
    listByParentThreadId: (i) =>
      listRows(i).pipe(
        Effect.mapError(mapError("ProjectionSubagentRepository.listByParentThreadId:query")),
        Effect.map((rows) => rows.map((r) => r.subagent)),
      ),
  } satisfies ProjectionSubagentRepositoryShape;
});
export const ProjectionSubagentRepositoryLive = Layer.effect(ProjectionSubagentRepository, make);
