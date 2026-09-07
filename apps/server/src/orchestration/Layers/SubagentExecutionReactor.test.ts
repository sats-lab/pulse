import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  SubagentId,
  ThreadId,
  TurnId,
  type PulseSubagent,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
const it = effectIt;
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  OrchestrationDomainEventBusLive,
  OrchestrationDomainEventSubscriptionLive,
} from "../Services/OrchestrationDomainEventSubscription.ts";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { SubagentExecutionReactor } from "../Services/SubagentExecutionReactor.ts";
import {
  SubagentDriverError,
  type SubagentDriver,
  type SubagentObservation,
} from "../Services/SubagentDriver.ts";
import {
  SubagentDriverFactoryService,
  SubagentExecutionReactorLive,
} from "./SubagentExecutionReactor.ts";
import { layer as registryLayer } from "../Services/SubagentLiveRegistry.ts";

const projectId = ProjectId.make("project-reactor");
const threadId = ThreadId.make("thread-reactor");
const now = "2026-01-01T00:00:00.000Z";
const subagent = (id: string, status: PulseSubagent["status"] = "created"): PulseSubagent => ({
  id: SubagentId.make(id),
  origin: { projectId, threadId, turnId: TurnId.make(`turn-${id}`) },
  title: id,
  prompt: "test",
  metadata: { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  effort: "high",
  status,
  delivery: "none",
  createdAt: now,
});
const parents = [
  {
    type: "project.create" as const,
    commandId: CommandId.make("project"),
    projectId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    createdAt: now,
  },
  {
    type: "thread.create" as const,
    commandId: CommandId.make("thread"),
    threadId,
    projectId,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access" as const,
    branch: null,
    worktreePath: null,
    createdAt: now,
  },
];
type Options = {
  attach?: (
    value: PulseSubagent,
    queue: Queue.Queue<SubagentObservation>,
    receipt: Queue.Queue<void>,
  ) => Effect.Effect<SubagentDriver, SubagentDriverError>;
};
const makeSystem = async (options: Options = {}) => {
  const base = Layer.mergeAll(
    OrchestrationDomainEventBusLive,
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationDomainEventBusLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "subagent-reactor-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const observations = await Effect.runPromise(Queue.unbounded<SubagentObservation>());
  const observationReceipts = await Effect.runPromise(Queue.unbounded<void>());
  const starts: string[] = [],
    stops: string[] = [],
    cleanups: string[] = [];
  const factory = Layer.succeed(SubagentDriverFactoryService, {
    attach: ({ subagent: value }) =>
      options.attach?.(value, observations, observationReceipts) ??
      Effect.succeed<SubagentDriver>({
        input: value,
        observations: Stream.fromQueue(observations).pipe(
          Stream.tap(() => Queue.offer(observationReceipts, undefined)),
        ),
        start: Effect.sync(() => starts.push(value.id)),
        stop: Effect.sync(() => stops.push(value.id)),
        dispose: Effect.sync(() => cleanups.push(value.id)),
      }),
  });
  const runtime = ManagedRuntime.make(
    SubagentExecutionReactorLive.pipe(
      Layer.provideMerge(OrchestrationDomainEventSubscriptionLive),
      Layer.provideMerge(OrchestrationDomainEventBusLive),
      Layer.provideMerge(registryLayer),
      Layer.provideMerge(factory),
      Layer.provideMerge(base),
    ),
  );
  const scope = await runtime.runPromise(Scope.make());
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const reactor = await runtime.runPromise(Effect.service(SubagentExecutionReactor));
  const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    runtime.runPromise(engine.dispatch(command));
  for (const command of parents) await dispatch(command);
  const offerObservation = (observation: SubagentObservation) =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* Queue.offer(observations, observation);
        yield* Queue.take(observationReceipts);
        yield* Effect.yieldNow;
      }),
    );
  return {
    runtime,
    scope,
    reactor,
    query,
    observations,
    observationReceipts,
    offerObservation,
    starts,
    stops,
    cleanups,
    dispatch,
  };
};
const create = (
  dispatch: (command: OrchestrationCommand) => Promise<unknown>,
  value: PulseSubagent,
) =>
  dispatch({
    type: "subagent.create",
    commandId: CommandId.make(`create-${value.id}`),
    subagentId: value.id,
    subagent: value,
  });
const status = async (query: ProjectionSnapshotQueryShape, id: SubagentId) =>
  (await Effect.runPromise(query.getSnapshot())).subagents?.find((value) => value.id === id)
    ?.status;

describe("SubagentExecutionReactor", () => {
  it("projects progress, waiting, and completion", async () => {
    const x = await makeSystem();
    await x.runtime.runPromise(x.reactor.start.pipe(Scope.provide(x.scope)));
    const s = subagent("flow");
    await create(x.dispatch, s);
    await x.runtime.runPromise(x.reactor.drain);
    for (const observation of [
      { kind: "started" as const },
      { kind: "progress" as const, text: "halfway" },
      { kind: "waiting" as const },
      { kind: "completed" as const },
    ])
      await x.offerObservation({ subagentId: s.id, ...observation });
    await x.runtime.runPromise(x.reactor.drain);
    expect(await status(x.query, s.id)).toBe("completed");
    await x.runtime.dispose();
  });
  it("fails attach and cleans up observation failures", async () => {
    const x = await makeSystem({
      attach: (s) => Effect.fail(new SubagentDriverError({ subagentId: s.id, message: "attach" })),
    });
    await x.runtime.runPromise(x.reactor.start.pipe(Scope.provide(x.scope)));
    const s = subagent("attach-fail");
    await create(x.dispatch, s);
    await x.runtime.runPromise(x.reactor.drain);
    expect(await status(x.query, s.id)).toBe("failed");
    await x.runtime.dispose();
    const y = await makeSystem({
      attach: (s, q, receipt) =>
        Effect.succeed({
          input: s,
          observations: Stream.fromQueue(q).pipe(
            Stream.take(1),
            Stream.tap(() => Queue.offer(receipt, undefined)),
            Stream.concat(
              Stream.fromEffect(
                Queue.offer(receipt, undefined).pipe(
                  Effect.andThen(
                    Effect.fail(new SubagentDriverError({ subagentId: s.id, message: "stream" })),
                  ),
                ),
              ),
            ),
          ),
          start: Effect.void,
          stop: Effect.void,
          dispose: Effect.void,
        }),
    });
    await y.runtime.runPromise(y.reactor.start.pipe(Scope.provide(y.scope)));
    const t = subagent("stream-fail");
    await create(y.dispatch, t);
    await y.runtime.runPromise(y.reactor.drain);
    await y.offerObservation({ subagentId: t.id, kind: "started" });
    await y.runtime.runPromise(Queue.take(y.observationReceipts));
    await y.runtime.runPromise(y.reactor.drain);
    expect(await status(y.query, t.id)).toBe("failed");
    await y.runtime.dispose();
  });
  it("stops a requested driver", async () => {
    const x = await makeSystem();
    await x.runtime.runPromise(x.reactor.start.pipe(Scope.provide(x.scope)));
    const s = subagent("stop");
    await create(x.dispatch, s);
    await x.runtime.runPromise(x.reactor.drain);
    await x.dispatch({
      type: "subagent.stop-request",
      commandId: CommandId.make("request-stop"),
      subagentId: s.id,
      createdAt: now,
    });
    await x.runtime.runPromise(x.reactor.drain);
    expect(x.stops).toEqual([s.id]);
    expect(await status(x.query, s.id)).toBe("stopped");
    await x.runtime.dispose();
  });
  it("interrupts only nonterminal subagents on startup", async () => {
    const x = await makeSystem();
    const live = subagent("live"),
      done = subagent("done", "completed");
    await create(x.dispatch, live);
    await create(x.dispatch, done);
    await x.runtime.runPromise(x.reactor.start.pipe(Scope.provide(x.scope)));
    expect(await status(x.query, live.id)).toBe("interrupted");
    expect(await status(x.query, done.id)).toBe("completed");
    await x.runtime.dispose();
  });
  it("enforces four live subagents per parent, but not across parents", async () => {
    const x = await makeSystem();
    await x.runtime.runPromise(x.reactor.start.pipe(Scope.provide(x.scope)));
    for (let i = 0; i < 5; i++) {
      const s = subagent(`limit-${i}`);
      await create(x.dispatch, s);
    }
    await x.runtime.runPromise(x.reactor.drain);
    expect(await status(x.query, SubagentId.make("limit-4"))).toBe("failed");
    await x.runtime.dispose();
  });
  it("keeps the first terminal observation", async () => {
    const x = await makeSystem();
    await x.runtime.runPromise(x.reactor.start.pipe(Scope.provide(x.scope)));
    const s = subagent("duplicate");
    await create(x.dispatch, s);
    await x.runtime.runPromise(x.reactor.drain);
    await x.offerObservation({ subagentId: s.id, kind: "completed" });
    await x.offerObservation({ subagentId: s.id, kind: "failed", text: "late" });
    await x.runtime.runPromise(x.reactor.drain);
    expect(await status(x.query, s.id)).toBe("completed");
    await x.runtime.dispose();
  });
});
