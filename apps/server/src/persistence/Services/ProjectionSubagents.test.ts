import {
  ProviderInstanceId,
  ProjectId,
  SubagentId,
  ThreadId,
  TurnId,
  type PulseSubagent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ProjectionSubagentRepository } from "./ProjectionSubagents.ts";
import { ProjectionSubagentRepositoryLive } from "../Layers/ProjectionSubagents.ts";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";

const layer = it.layer(
  ProjectionSubagentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const makeSubagent = (
  id: string,
  createdAt: string,
  threadId = "thread-parent",
): PulseSubagent => ({
  id: SubagentId.make(id),
  title: "Test subagent",
  prompt: "Test prompt",
  origin: {
    projectId: ProjectId.make("project"),
    threadId: ThreadId.make(threadId),
    turnId: TurnId.make("turn"),
  },
  metadata: { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  status: "created",
  delivery: "none",
  createdAt,
});
layer("ProjectionSubagentRepository", (it) => {
  it.effect("upserts, reads, updates, and orders by parent and creation", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionSubagentRepository;
      const first = makeSubagent("b", "2026-01-01T00:00:00.000Z");
      const second = makeSubagent("a", "2026-01-01T00:00:00.000Z");
      yield* repository.upsert(first);
      yield* repository.upsert(second);
      yield* repository.upsert({ ...first, metadata: { ...first.metadata, model: "gpt-5-mini" } });
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.getById({ subagentId: first.id })),
        { ...first, metadata: { ...first.metadata, model: "gpt-5-mini" } },
      );
      assert.deepStrictEqual(
        yield* repository.listByParentThreadId({ threadId: ThreadId.make("thread-parent") }),
        [{ ...second }, { ...first, metadata: { ...first.metadata, model: "gpt-5-mini" } }],
      );
      assert.isTrue(
        Option.isNone(yield* repository.getById({ subagentId: SubagentId.make("missing") })),
      );
      yield* repository.upsert(
        makeSubagent("other-parent", "2026-01-02T00:00:00.000Z", "thread-other"),
      );
      assert.deepStrictEqual(
        yield* repository.listByParentThreadId({ threadId: ThreadId.make("thread-parent") }),
        [{ ...second }, { ...first, metadata: { ...first.metadata, model: "gpt-5-mini" } }],
      );
    }),
  );
});
