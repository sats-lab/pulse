import {
  CommandId,
  EventId,
  ProjectId,
  SubagentId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.make("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.make("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("stores and replays subagent.created aggregate and actor fields", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const subagentId = SubagentId.make("subagent-store");
      const commandId = CommandId.make("server:subagent-store");
      const appended = yield* eventStore.append({
        type: "subagent.created",
        eventId: EventId.make("evt-subagent-store"),
        aggregateKind: "subagent",
        aggregateId: subagentId,
        occurredAt: "2026-01-01T00:00:00.000Z",
        commandId,
        causationEventId: null,
        correlationId: commandId,
        metadata: {},
        payload: {
          subagent: {
            id: subagentId,
            origin: {
              projectId: ProjectId.make("project-store"),
              threadId: ThreadId.make("thread-store"),
              turnId: TurnId.make("turn-store"),
            },
            title: "Stored subagent",
            prompt: "Stored prompt",
            metadata: { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            status: "created",
            delivery: "none",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
      });
      const rows = yield* sql<{
        readonly aggregateKind: string;
        readonly streamId: string;
        readonly commandId: string;
        readonly correlationId: string;
        readonly actorKind: string;
      }>`SELECT aggregate_kind AS "aggregateKind", stream_id AS "streamId", command_id AS "commandId", correlation_id AS "correlationId", actor_kind AS "actorKind" FROM orchestration_events WHERE event_id = ${appended.eventId}`;
      assert.deepStrictEqual(rows, [
        {
          aggregateKind: "subagent",
          streamId: subagentId,
          commandId,
          correlationId: commandId,
          actorKind: "server",
        },
      ]);
      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10));
      const replayedSubagent = replayed.find((event) => event.type === "subagent.created");
      assert.equal(replayedSubagent?.type, "subagent.created");
      assert.equal(replayedSubagent?.aggregateId, subagentId);
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-01T00:00:00.000Z";

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.make("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.make("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.make("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(isPersistenceDecodeError(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );
});
