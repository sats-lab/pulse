import { PulseSubagent, SubagentId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { LiveSubagentHandle } from "./SubagentDriver.ts";

export class SubagentLiveRegistryError extends Schema.TaggedErrorClass<SubagentLiveRegistryError>()(
  "SubagentLiveRegistryError",
  {
    subagentId: SubagentId,
    reason: Schema.Union([Schema.Literal("parent-deleted"), Schema.Literal("duplicate")]),
    message: Schema.String,
  },
) {}

export class SubagentLiveRegistry extends Context.Service<
  SubagentLiveRegistry,
  {
    readonly add: (handle: LiveSubagentHandle) => Effect.Effect<void, SubagentLiveRegistryError>;
    readonly deleteParentThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<LiveSubagentHandle>>;
    readonly get: (id: SubagentId) => Effect.Effect<LiveSubagentHandle | undefined>;
    readonly remove: (id: SubagentId) => Effect.Effect<LiveSubagentHandle | undefined>;
    readonly listByParentThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<LiveSubagentHandle>>;
    readonly clear: () => Effect.Effect<void>;
  }
>()("@sats-lab/pulse/orchestration/Services/SubagentLiveRegistry") {}

export const layer = Layer.effect(
  SubagentLiveRegistry,
  Effect.gen(function* () {
    const state = yield* Ref.make({
      entries: new Map<SubagentId, LiveSubagentHandle>(),
      deleted: new Set<ThreadId>(),
    });
    const add = (handle: LiveSubagentHandle) =>
      Ref.modify(state, (current) => {
        if (current.deleted.has(handle.subagent.origin.threadId)) return [false, current];
        if (current.entries.has(handle.subagent.id)) return [true, current];
        const entries = new Map(current.entries);
        entries.set(handle.subagent.id, handle);
        return [null, { ...current, entries }];
      }).pipe(
        Effect.flatMap((result) =>
          result === false
            ? Effect.fail(
                new SubagentLiveRegistryError({
                  subagentId: handle.subagent.id,
                  reason: "parent-deleted",
                  message: "The parent thread has been deleted",
                }),
              )
            : result === true
              ? Effect.fail(
                  new SubagentLiveRegistryError({
                    subagentId: handle.subagent.id,
                    reason: "duplicate" as const,
                    message: "A live handle already exists for this subagent",
                  }),
                )
              : Effect.void,
        ),
      );
    const deleteParentThread = (threadId: ThreadId) =>
      Ref.modify(state, (current) => {
        const handles = [...current.entries.values()].filter(
          ({ subagent }) => subagent.origin.threadId === threadId,
        );
        const entries = new Map(current.entries);
        for (const handle of handles) entries.delete(handle.subagent.id);
        return [handles, { entries, deleted: new Set(current.deleted).add(threadId) }];
      });
    return SubagentLiveRegistry.of({
      add: add,
      deleteParentThread,
      get: (id) => Ref.get(state).pipe(Effect.map(({ entries }) => entries.get(id))),
      remove: (id) =>
        Ref.modify(state, ({ entries, deleted }) => {
          const value = entries.get(id);
          const next = new Map(entries);
          next.delete(id);
          return [value, { entries: next, deleted }];
        }),
      listByParentThread: (threadId) =>
        Ref.get(state).pipe(
          Effect.map(({ entries }) =>
            [...entries.values()].filter(({ subagent }) => subagent.origin.threadId === threadId),
          ),
        ),
      clear: () => Ref.update(state, ({ deleted }) => ({ entries: new Map(), deleted })),
    });
  }),
);
export const make = layer;
