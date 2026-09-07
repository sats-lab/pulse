import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentId,
  ThreadId,
  TurnId,
  type PulseSubagent,
  type ProviderDeliverSubagentResultInput,
  type ProviderDeliverSubagentResultResult,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
const it = effectIt;
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  OrchestrationDomainEventBusLive,
  OrchestrationDomainEventSubscriptionLive,
} from "../Services/OrchestrationDomainEventSubscription.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ServerConfig } from "../../config.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { SubagentResultDeliveryReactor } from "../Services/SubagentResultDeliveryReactor.ts";
import { SubagentResultDeliveryReactorLive } from "./SubagentResultDeliveryReactor.ts";

const projectId = ProjectId.make("delivery-project");
const threadId = ThreadId.make("delivery-parent");
const time = "2026-01-01T00:00:00.000Z";
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "delivery-reactor-" })),
  Layer.provideMerge(NodeServices.layer),
);

const subagent = (id: string): PulseSubagent => ({
  id: SubagentId.make(id),
  origin: { projectId, threadId, turnId: TurnId.make(`turn-${id}`) },
  title: "Worker result",
  prompt: "do work",
  metadata: { providerInstanceId: ProviderInstanceId.make("pi"), model: "model" },
  effort: "high",
  status: "created",
  delivery: "none",
  createdAt: time,
});
const providerStub = (
  deliver: (
    input: ProviderDeliverSubagentResultInput,
  ) => Effect.Effect<ProviderDeliverSubagentResultResult, ProviderAdapterRequestError> = () =>
    Effect.succeed({
      provider: ProviderDriverKind.make("pi"),
      providerInstanceId: ProviderInstanceId.make("pi"),
      accepted: true,
      alreadyPresent: false,
      acceptedAt: time,
    }),
) =>
  ({
    deliverSubagentResult: deliver,
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    interruptTurn: () => Effect.die("unused"),
    mutateInputQueue: () => Effect.die("unused"),
    respondToRequest: () => Effect.die("unused"),
    respondToUserInput: () => Effect.die("unused"),
    stopSession: () => Effect.die("unused"),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.die("unused"),
    getInstanceInfo: () => Effect.die("unused"),
    rollbackConversation: () => Effect.die("unused"),
    streamEvents: Stream.empty,
  }) satisfies ProviderServiceShape;

const make = async (provider = providerStub()) => {
  const runtime = ManagedRuntime.make(
    SubagentResultDeliveryReactorLive.pipe(
      Layer.provideMerge(OrchestrationDomainEventSubscriptionLive),
      Layer.provideMerge(base),
      Layer.provideMerge(Layer.succeed(ProviderService, provider)),
      Layer.provideMerge(TestClock.layer()),
    ),
  );
  const scope = await runtime.runPromise(Scope.make());
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const reactor = await runtime.runPromise(Effect.service(SubagentResultDeliveryReactor));
  const dispatch = (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command));
  await dispatch({
    type: "project.create",
    commandId: CommandId.make("project"),
    projectId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "model" },
    createdAt: time,
  });
  await dispatch({
    type: "thread.create",
    commandId: CommandId.make("thread"),
    threadId,
    projectId,
    title: "Parent",
    modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "model" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: time,
  });
  await runtime.runPromise(reactor.start().pipe(Scope.provide(scope)));
  return { runtime, scope, reactor, query, dispatch };
};
const complete = async (
  dispatch: (command: OrchestrationCommand) => Promise<unknown>,
  value: PulseSubagent,
) => {
  await dispatch({
    type: "subagent.create",
    commandId: CommandId.make(`create-${value.id}`),
    subagentId: value.id,
    subagent: value,
  });
  await dispatch({
    type: "subagent.complete",
    commandId: CommandId.make(`complete-${value.id}`),
    subagentId: value.id,
    result: "final answer",
    createdAt: time,
  });
};
const delivery = async (query: ProjectionSnapshotQueryShape, id: SubagentId) =>
  (await Effect.runPromise(query.getSnapshot())).subagents?.find((s) => s.id === id)
    ?.resultDelivery;
const ready = (dispatch: (command: OrchestrationCommand) => Promise<unknown>) =>
  dispatch({
    type: "thread.session.set",
    commandId: CommandId.make("session"),
    threadId,
    session: {
      threadId,
      status: "ready",
      providerName: "pi",
      providerInstanceId: ProviderInstanceId.make("pi"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: time,
    },
    createdAt: time,
  });

const run = async (x: Awaited<ReturnType<typeof make>>) => {
  await x.runtime.runPromise(x.reactor.drain);
};
const cleanup = async (x: Awaited<ReturnType<typeof make>>) => {
  await x.runtime.runPromise(Scope.close(x.scope, Exit.void));
  await x.runtime.dispose();
};
describe("SubagentResultDeliveryReactor", () => {
  it("attempts a queued ready result with the exact provider input", async () => {
    const calls: ProviderDeliverSubagentResultInput[] = [];
    const x = await make(
      providerStub((input) =>
        Effect.sync(() => {
          calls.push(input);
          return {
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: ProviderInstanceId.make("pi"),
            accepted: true,
            alreadyPresent: false,
            acceptedAt: time,
          };
        }),
      ),
    );
    await ready(x.dispatch);
    const s = subagent("exact");
    await complete(x.dispatch, s);
    await run(x);
    expect(calls).toEqual([
      {
        parentThreadId: threadId,
        deliveryId: (await delivery(x.query, s.id))!.deliveryId,
        subagentId: s.id,
        originTurnId: s.origin.turnId,
        title: s.title,
        result: "final answer",
      },
    ]);
    expect((await delivery(x.query, s.id))?.status).toBe("delivered");
    await cleanup(x);
  });
  it("accepts already-present results and does not call when the parent is ineligible", async () => {
    let calls = 0;
    const x = await make(
      providerStub(() =>
        Effect.sync(() => {
          calls++;
          return {
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: ProviderInstanceId.make("pi"),
            accepted: true,
            alreadyPresent: true,
            acceptedAt: time,
          };
        }),
      ),
    );
    const s = subagent("blocked");
    await complete(x.dispatch, s);
    await run(x);
    expect(calls).toBe(0);
    expect((await delivery(x.query, s.id))?.status).toBe("blocked");
    await ready(x.dispatch);
    await run(x);
    expect(calls).toBe(1);
    expect((await delivery(x.query, s.id))?.status).toBe("delivered");
    await cleanup(x);
  });
  it("retries request errors at 30 seconds, not earlier, exactly once", async () => {
    let calls = 0;
    const x = await make(
      providerStub(() =>
        Effect.sync(() => {
          calls++;
          return calls === 1
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider: ProviderDriverKind.make("pi"),
                  method: "deliver",
                  detail: "busy",
                }),
              )
            : Effect.succeed({
                provider: ProviderDriverKind.make("pi"),
                providerInstanceId: ProviderInstanceId.make("pi"),
                accepted: true,
                alreadyPresent: false,
                acceptedAt: time,
              });
        }).pipe(Effect.flatten),
      ),
    );
    await ready(x.dispatch);
    const s = subagent("retry");
    await complete(x.dispatch, s);
    await run(x);
    expect(calls).toBe(1);
    expect((await delivery(x.query, s.id))?.status).toBe("retry-scheduled");
    await x.runtime.runPromise(TestClock.adjust("29999 millis"));
    await run(x);
    expect(calls).toBe(1);
    await x.runtime.runPromise(TestClock.adjust("1 second"));
    await run(x);
    expect(calls).toBe(2);
    expect((await delivery(x.query, s.id))?.status).toBe("delivered");
    await cleanup(x);
  });

  it("does not retry a blocked result until the parent session becomes ready", async () => {
    let calls = 0;
    const x = await make(
      providerStub(() =>
        Effect.sync(() => {
          calls++;
          return {
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: ProviderInstanceId.make("pi"),
            accepted: true,
            alreadyPresent: false,
            acceptedAt: time,
          };
        }),
      ),
    );
    const s = subagent("blocked-retry");
    await complete(x.dispatch, s);
    await run(x);
    expect((await delivery(x.query, s.id))?.status).toBe("blocked");
    expect(calls).toBe(0);
    await ready(x.dispatch);
    await run(x);
    expect(calls).toBe(1);
    expect((await delivery(x.query, s.id))?.status).toBe("delivered");
    await cleanup(x);
  });

  it("does not redeliver an already delivered result", async () => {
    let calls = 0;
    const x = await make(
      providerStub(() =>
        Effect.sync(() => {
          calls++;
          return {
            provider: ProviderDriverKind.make("pi"),
            providerInstanceId: ProviderInstanceId.make("pi"),
            accepted: true,
            alreadyPresent: false,
            acceptedAt: time,
          };
        }),
      ),
    );
    await ready(x.dispatch);
    const s = subagent("dedupe");
    await complete(x.dispatch, s);
    await run(x);
    await run(x);
    expect(calls).toBe(1);
    expect((await delivery(x.query, s.id))?.status).toBe("delivered");
    await cleanup(x);
  });

  it("cancels delivery when the parent is deleted", async () => {
    const x = await make();
    const s = subagent("deleted-parent");
    await complete(x.dispatch, s);
    await run(x);
    await x.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-parent"),
      threadId,
    });
    await run(x);
    expect((await delivery(x.query, s.id))?.status).toBe("cancelled");
    await cleanup(x);
  });

  it("cancels an in-flight delivery when the parent is deleted", async () => {
    const x = await make();
    const started = await x.runtime.runPromise(Deferred.make<void>());
    const release = await x.runtime.runPromise(Deferred.make<void>());
    const provider = providerStub(() =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        return {
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: ProviderInstanceId.make("pi"),
          accepted: true,
          alreadyPresent: false,
          acceptedAt: time,
        };
      }),
    );
    await cleanup(x);
    const y = await make(provider);
    await ready(y.dispatch);
    const s = subagent("in-flight-delete");
    await complete(y.dispatch, s);
    const deliveryRun = y.runtime.runPromise(y.reactor.drain);
    await y.runtime.runPromise(Deferred.await(started));
    await y.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-in-flight"),
      threadId,
    });
    await y.runtime.runPromise(Deferred.succeed(release, undefined));
    await deliveryRun;
    await run(y);
    expect((await delivery(y.query, s.id))?.status).toBe("cancelled");
    await cleanup(y);
  });
});
