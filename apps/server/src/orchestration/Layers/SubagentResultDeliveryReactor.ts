import {
  CommandId,
  ResultDeliveryAttemptId,
  type OrchestrationEvent,
  type PulseSubagent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import { forkParked } from "../../serverActivation.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderDeliveryRetryableError,
} from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationDomainEventSubscription } from "../Services/OrchestrationDomainEventSubscription.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SubagentResultDeliveryReactor,
  type SubagentResultDeliveryReactorShape,
} from "../Services/SubagentResultDeliveryReactor.ts";

const retryDelayMs = 30_000;
type WorkItem =
  | { readonly tag: "process" }
  | { readonly tag: "schedule"; readonly deliveryId: string; readonly nextAttemptAt: string }
  | { readonly tag: "cancel"; readonly deliveryId: string };

export const makeSubagentResultDeliveryReactor = Effect.gen(function* () {
  const events = yield* OrchestrationDomainEventSubscription;
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const provider = yield* ProviderService;
  const crypto = yield* Crypto.Crypto;
  const now = () => DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((id) => CommandId.make(`server:result-delivery:${tag}:${id}`)),
    );
  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(Effect.asVoid);
  const timers = yield* FiberMap.make<string, void, never>();
  const cancelTimer = (deliveryId: string) => FiberMap.remove(timers, deliveryId);

  let worker: DrainableWorker<WorkItem> | undefined;
  const enqueue = (item: WorkItem) =>
    worker === undefined
      ? Effect.die("result delivery worker is not initialized")
      : worker.enqueue(item);
  const process = Effect.fn("SubagentResultDeliveryReactor.process")(function* () {
    const snapshot = yield* query.getSnapshot();
    for (const subagent of snapshot.subagents ?? []) {
      const delivery = subagent.resultDelivery;
      if (delivery == null || ["delivered", "cancelled"].includes(delivery.status)) continue;
      const parent = snapshot.threads?.find(
        (thread) => thread.id === subagent.origin.threadId && thread.deletedAt === null,
      );
      if (parent === undefined) {
        yield* dispatch({
          type: "result-delivery.cancel",
          commandId: yield* commandId("cancel"),
          subagentId: subagent.id,
          deliveryId: delivery.deliveryId,
          createdAt: yield* now(),
          reason: "Parent thread deleted",
        });
        continue;
      }
      if (delivery.status === "retry-scheduled" && delivery.nextAttemptAt !== undefined) {
        const current = yield* DateTime.now;
        const next = DateTime.make(delivery.nextAttemptAt);
        if (Option.isSome(next) && DateTime.isLessThan(current, next.value)) {
          yield* enqueue({
            tag: "schedule",
            deliveryId: delivery.deliveryId,
            nextAttemptAt: delivery.nextAttemptAt,
          });
          continue;
        }
      }
      if (delivery.status === "attempting") {
        const attemptId = delivery.attemptId;
        if (attemptId !== undefined) {
          yield* dispatch({
            type: "result-delivery.retry",
            commandId: yield* commandId("recover"),
            subagentId: subagent.id,
            deliveryId: delivery.deliveryId,
            attemptId,
            createdAt: yield* now(),
            nextAttemptAt: yield* now(),
            reason: "Recovered stale attempting delivery",
          });
        }
        continue;
      }
      if (delivery.status === "blocked" && parent.session?.status !== "ready") continue;
      const attemptId = ResultDeliveryAttemptId.make(yield* crypto.randomUUIDv4);
      yield* dispatch({
        type: "result-delivery.attempt",
        commandId: yield* commandId("attempt"),
        subagentId: subagent.id,
        deliveryId: delivery.deliveryId,
        attemptId,
        createdAt: yield* now(),
      });
      if (parent.session?.status !== "ready") {
        yield* dispatch({
          type: "result-delivery.block",
          commandId: yield* commandId("block"),
          subagentId: subagent.id,
          deliveryId: delivery.deliveryId,
          attemptId,
          createdAt: yield* now(),
          reason: "Parent provider session is not eligible",
        });
        continue;
      }
      if (provider.deliverSubagentResult === undefined) {
        yield* dispatch({
          type: "result-delivery.block",
          commandId: yield* commandId("block"),
          subagentId: subagent.id,
          deliveryId: delivery.deliveryId,
          attemptId,
          createdAt: yield* now(),
          reason: "Provider does not support subagent result delivery",
        });
        continue;
      }
      const result = yield* provider
        .deliverSubagentResult({
          parentThreadId: subagent.origin.threadId,
          deliveryId: delivery.deliveryId,
          subagentId: subagent.id,
          originTurnId: subagent.origin.turnId,
          title: subagent.title,
          result: subagent.result ?? null,
        })
        .pipe(
          Effect.map((value) => ({ _tag: "success" as const, value })),
          Effect.catchTags({
            ProviderAdapterRequestError: (error) =>
              Effect.succeed({ _tag: "retry" as const, error }),
            ProviderAdapterProcessError: (error) =>
              Effect.succeed({ _tag: "retry" as const, error }),
            ProviderDeliveryRetryableError: (error) =>
              Effect.succeed({ _tag: "retry" as const, error }),
          }),
          Effect.catch((error) => Effect.succeed({ _tag: "block" as const, error })),
        );
      const parentAfterProvider = (yield* query.getSnapshot()).threads?.find(
        (thread) => thread.id === subagent.origin.threadId,
      );
      if (parentAfterProvider === undefined || parentAfterProvider.deletedAt !== null) {
        yield* dispatch({
          type: "result-delivery.cancel",
          commandId: yield* commandId("cancel-after-provider"),
          subagentId: subagent.id,
          deliveryId: delivery.deliveryId,
          createdAt: yield* now(),
          reason: "Parent thread deleted",
        });
      } else if (result._tag === "success") {
        yield* dispatch({
          type: "result-delivery.deliver",
          commandId: yield* commandId("deliver"),
          subagentId: subagent.id,
          deliveryId: delivery.deliveryId,
          attemptId,
          createdAt: yield* now(),
          diagnostics: { provider: result.value.provider, accepted: String(result.value.accepted) },
        });
      } else if (result._tag === "retry") {
        const nextAttemptAt = yield* DateTime.now.pipe(
          Effect.map((value) => DateTime.add(value, { milliseconds: retryDelayMs })),
          Effect.map(DateTime.formatIso),
        );
        yield* dispatch({
          type: "result-delivery.retry",
          commandId: yield* commandId("retry"),
          subagentId: subagent.id,
          deliveryId: delivery.deliveryId,
          attemptId,
          createdAt: yield* now(),
          nextAttemptAt,
          reason: result.error.detail,
        });
      } else {
        yield* dispatch({
          type: "result-delivery.block",
          commandId: yield* commandId("block"),
          subagentId: subagent.id,
          deliveryId: delivery.deliveryId,
          attemptId,
          createdAt: yield* now(),
          reason: String(result.error),
        });
      }
    }
  });
  worker = yield* makeDrainableWorker<WorkItem, never, Scope.Scope>((item) =>
    Effect.gen(function* () {
      switch (item.tag) {
        case "process":
          yield* process();
          return;
        case "cancel":
          yield* cancelTimer(item.deliveryId);
          return;
        case "schedule": {
          yield* cancelTimer(item.deliveryId);
          const due = DateTime.make(item.nextAttemptAt);
          if (Option.isNone(due)) return;
          const current = yield* Clock.currentTimeMillis;
          const delay = Math.max(0, DateTime.toEpochMillis(due.value) - current);
          yield* FiberMap.run(
            timers,
            item.deliveryId,
            Effect.sleep(Duration.millis(delay)).pipe(
              Effect.andThen(enqueue({ tag: "process" })),
              Effect.asVoid,
            ),
          );
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("result delivery reactor failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );
  const startEffect = Effect.gen(function* () {
    const subscription = yield* events.subscribe;
    yield* process().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("result delivery startup recovery failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    const startup = yield* query.getSnapshot();
    for (const subagent of startup.subagents ?? []) {
      const delivery = subagent.resultDelivery;
      if (
        delivery?.status === "retry-scheduled" &&
        "nextAttemptAt" in delivery &&
        delivery.nextAttemptAt !== undefined
      ) {
        yield* enqueue({
          tag: "schedule",
          deliveryId: delivery.deliveryId,
          nextAttemptAt: delivery.nextAttemptAt,
        });
      }
    }
    yield* forkParked(
      Effect.forever(
        PubSub.take(subscription).pipe(
          Effect.flatMap((event) => {
            switch (event.type) {
              case "result-delivery.retry-scheduled":
                return enqueue({ tag: "process" });
              case "result-delivery.delivered":
              case "result-delivery.cancelled":
              case "result-delivery.blocked":
                return enqueue({ tag: "cancel", deliveryId: event.payload.deliveryId });
              case "result-delivery.queued":
              case "thread.session-set":
              case "thread.deleted":
              case "subagent.completed":
                return enqueue({ tag: "process" });
              default:
                return Effect.void;
            }
          }),
        ),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("result delivery reactor startup failed", { cause: Cause.pretty(cause) }),
    ),
    Effect.withSpan("SubagentResultDeliveryReactor.start"),
  );
  const start: SubagentResultDeliveryReactorShape["start"] = () => startEffect;
  return {
    start,
    drain: worker.drain,
  } satisfies SubagentResultDeliveryReactorShape;
});
export const SubagentResultDeliveryReactorLive = Layer.effect(
  SubagentResultDeliveryReactor,
  makeSubagentResultDeliveryReactor,
);
