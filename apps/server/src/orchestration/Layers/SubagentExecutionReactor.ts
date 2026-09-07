import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type PulseSubagent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { forkParked } from "../../serverActivation.ts";
import {
  SubagentDriverError,
  type SubagentDriver,
  type SubagentObservation,
} from "../Services/SubagentDriver.ts";
import { SubagentLiveRegistry } from "../Services/SubagentLiveRegistry.ts";
import { OrchestrationDomainEventSubscription } from "../Services/OrchestrationDomainEventSubscription.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SubagentExecutionReactor,
  type SubagentExecutionReactorShape,
} from "../Services/SubagentExecutionReactor.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";

export interface SubagentDriverFactory {
  /** Create and attach a provider-neutral execution handle. Starting is owned by the reactor. */
  readonly attach: (input: {
    readonly subagent: PulseSubagent;
    readonly cwd: string;
  }) => Effect.Effect<SubagentDriver, SubagentDriverError>;
}
export class SubagentDriverFactoryService extends Context.Service<
  SubagentDriverFactoryService,
  SubagentDriverFactory
>()("@sats-lab/pulse/orchestration/Layers/SubagentExecutionReactor/SubagentDriverFactoryService") {}

const terminalObservations = new Set<SubagentObservation["kind"]>([
  "completed",
  "failed",
  "stopped",
]);
const terminalStatuses = new Set<PulseSubagent["status"]>([
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);
type Event = OrchestrationEvent;

export const makeSubagentExecutionReactor = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const now = () => DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((id) => CommandId.make(`server:subagent:${tag}:${id}`)));
  const eventSubscription = yield* OrchestrationDomainEventSubscription;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const registry = yield* SubagentLiveRegistry;
  const factory = yield* SubagentDriverFactoryService;
  const dispatch = (command: OrchestrationCommand) => engine.dispatch(command).pipe(Effect.asVoid);
  const fail = (subagentId: PulseSubagent["id"], error: string) =>
    Effect.gen(function* () {
      const [id, createdAt] = yield* Effect.all([commandId("fail"), now()]);
      yield* dispatch({
        type: "subagent.fail",
        commandId: id,
        subagentId,
        createdAt,
        error: error.trim() || "Subagent driver failed",
      });
    });
  const lifecycle = (
    type:
      | "subagent.attach"
      | "subagent.start"
      | "subagent.wait"
      | "subagent.idle"
      | "subagent.stop",
    subagentId: PulseSubagent["id"],
  ) =>
    Effect.all({ commandId: commandId(type), createdAt: now() }).pipe(
      Effect.map(
        ({ commandId, createdAt }): OrchestrationCommand => ({
          type,
          commandId,
          subagentId,
          createdAt,
        }),
      ),
    );
  const terminalSeen = yield* Ref.make(new Set<PulseSubagent["id"]>());
  const observeOnce = (observation: SubagentObservation) =>
    Effect.gen(function* () {
      const terminal = terminalObservations.has(observation.kind);
      if (terminal) {
        const seen = yield* Ref.modify(terminalSeen, (current) => {
          if (current.has(observation.subagentId)) return [true, current];
          const next = new Set(current);
          next.add(observation.subagentId);
          return [false, next];
        });
        if (seen) return;
      }
      yield* observe(observation);
    });
  const observe = (observation: SubagentObservation) => {
    if (observation.kind === "progress")
      return observation.text === undefined
        ? Effect.void
        : Effect.gen(function* () {
            const text = observation.text;
            if (text === undefined) return;
            const commandIdValue = yield* commandId("progress");
            yield* dispatch({
              type: "subagent.progress",
              commandId: commandIdValue,
              subagentId: observation.subagentId,
              createdAt: yield* now(),
              progress: text,
            });
          });
    if (observation.kind === "failed")
      return fail(observation.subagentId, observation.text ?? "Subagent failed");
    const type =
      observation.kind === "started"
        ? "subagent.start"
        : observation.kind === "waiting"
          ? "subagent.wait"
          : "subagent.stop";
    if (observation.kind === "completed")
      return Effect.all({ commandId: commandId("complete"), createdAt: now() }).pipe(
        Effect.flatMap(({ commandId, createdAt }) =>
          dispatch({
            type: "subagent.complete",
            commandId,
            subagentId: observation.subagentId,
            createdAt,
            result: observation.text?.trim() || null,
          }),
        ),
      );
    return lifecycle(type, observation.subagentId).pipe(Effect.flatMap(dispatch));
  };
  const run = Effect.fn("SubagentExecutionReactor.run")(function* (subagent: PulseSubagent) {
    const context = yield* query.getThreadCheckpointContext(subagent.origin.threadId);
    if (Option.isNone(context)) return yield* fail(subagent.id, "Parent thread no longer exists");
    const currentSubagent = (yield* query.getSnapshot()).subagents?.find(
      (value) => value.id === subagent.id,
    );
    if (currentSubagent?.status === "stop-requested") {
      yield* lifecycle("subagent.stop", subagent.id).pipe(Effect.flatMap(dispatch));
      return;
    }
    if ((yield* registry.listByParentThread(subagent.origin.threadId)).length >= 4)
      return yield* fail(subagent.id, "Maximum of 4 live subagents per parent");
    const driver = yield* factory
      .attach({
        subagent,
        cwd: context.value.worktreePath ?? context.value.workspaceRoot,
      })
      .pipe(Effect.mapError((error) => error));
    const parentAfterAttach = (yield* query.getSnapshot()).threads?.find(
      (thread) => thread.id === subagent.origin.threadId,
    );
    if (parentAfterAttach === undefined || parentAfterAttach.deletedAt !== null) {
      yield* driver.dispose;
      yield* dispatch({
        type: "subagent.interrupt",
        commandId: yield* commandId("interrupt-deleted-parent"),
        subagentId: subagent.id,
        createdAt: yield* now(),
      });
      return;
    }
    yield* registry.add({ subagent, driver }).pipe(
      Effect.catchTag("SubagentLiveRegistryError", (error) =>
        Effect.gen(function* () {
          yield* driver.dispose.pipe(Effect.catchCause(() => Effect.void));
          if (error.reason === "parent-deleted") {
            yield* dispatch({
              type: "subagent.interrupt",
              commandId: yield* commandId("interrupt-deleted-parent"),
              subagentId: subagent.id,
              createdAt: yield* now(),
            });
            return;
          }
          return yield* new SubagentDriverError({
            subagentId: subagent.id,
            message: error.message,
          });
        }),
      ),
    );
    yield* lifecycle("subagent.attach", subagent.id).pipe(Effect.flatMap(dispatch));
    // Observation is deliberately detached from the event worker: a stop request
    // must be able to reach a running driver while its observation stream is open.
    yield* forkParked(
      driver.observations.pipe(
        Stream.runForEach((observation) =>
          observationWorker.enqueue(observation).pipe(Effect.asVoid),
        ),
        Effect.catchCause((cause) =>
          fail(subagent.id, Cause.pretty(cause)).pipe(Effect.catchCause(() => Effect.void)),
        ),
        Effect.ensuring(
          driver.dispose
            .pipe(Effect.catchCause(() => Effect.void))
            .pipe(Effect.andThen(registry.remove(subagent.id).pipe(Effect.asVoid))),
        ),
      ),
    );
    yield* driver.start;
  });
  const observationWorker = yield* makeDrainableWorker<SubagentObservation, never, Scope.Scope>(
    (observation) => observeOnce(observation).pipe(Effect.catchCause(() => Effect.void)),
  );
  const worker = yield* makeDrainableWorker<Event, never, Scope.Scope>((event: Event) => {
    switch (event.type) {
      case "subagent.created":
        return registry
          .get(event.payload.subagent.id)
          .pipe(
            Effect.flatMap((existing) => (existing ? Effect.void : run(event.payload.subagent))),
          )
          .pipe(
            Effect.catchCause((cause) =>
              fail(event.payload.subagent.id, Cause.pretty(cause)).pipe(
                Effect.catchCause(() => Effect.void),
              ),
            ),
          );
      case "subagent.stop-requested":
        return Effect.gen(function* () {
          const subagentId = event.payload.subagentId;
          const handle = yield* registry.get(subagentId);
          if (handle)
            yield* handle.driver.stop.pipe(
              Effect.catchCause((cause) =>
                fail(subagentId, Cause.pretty(cause)).pipe(Effect.catchCause(() => Effect.void)),
              ),
            );
          if (handle) yield* lifecycle("subagent.stop", subagentId).pipe(Effect.flatMap(dispatch));
        }).pipe(Effect.catchCause(() => Effect.void));
      default:
        return Effect.void;
    }
  });
  const start: SubagentExecutionReactorShape["start"] = Effect.gen(function* () {
    const subscription = yield* eventSubscription.subscribe;
    const snapshot = yield* query.getSnapshot();
    for (const subagent of snapshot.subagents ?? [])
      if (!terminalStatuses.has(subagent.status)) {
        const id = yield* commandId("interrupt");
        yield* dispatch({
          type: "subagent.interrupt",
          commandId: id,
          subagentId: subagent.id,
          createdAt: yield* now(),
        });
      }
    yield* Effect.forkScoped(
      Effect.forever(
        PubSub.take(subscription).pipe(
          Effect.flatMap((event) => {
            switch (event.type) {
              case "subagent.created":
              case "subagent.stop-requested":
                return worker.enqueue(event);
              default:
                return Effect.void;
            }
          }),
        ),
      ),
    );
  }).pipe(Effect.catchCause(() => Effect.void));
  return {
    start,
    drain: Effect.all([worker.drain, observationWorker.drain]).pipe(Effect.asVoid),
  } satisfies SubagentExecutionReactorShape;
});
export const SubagentExecutionReactorLive = Layer.effect(
  SubagentExecutionReactor,
  makeSubagentExecutionReactor,
);
