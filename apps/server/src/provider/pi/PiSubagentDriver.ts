import { type PulseSubagent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPiSession, type PiSessionFactoryInput } from "./PiSessionFactory.ts";
import {
  SubagentDriverError,
  type SubagentDriver,
  type SubagentObservation,
} from "../../orchestration/Services/SubagentDriver.ts";

export interface PiSubagentDriverInput extends Omit<
  PiSessionFactoryInput,
  "threadId" | "modelSelection" | "randomUUID"
> {
  readonly subagent: PulseSubagent;
  readonly cwd: string;
  readonly modelSelection?: PiSessionFactoryInput["modelSelection"];
  readonly randomUUID?: PiSessionFactoryInput["randomUUID"];
}
const detail = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "detail" in cause) {
    const value = cause.detail;
    if (typeof value === "string") return value;
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
};
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const withThinking = (
  selection: PiSessionFactoryInput["modelSelection"],
  thinking: PulseSubagent["thinking"],
): NonNullable<PiSessionFactoryInput["modelSelection"]> => {
  const options = (selection?.options ?? []).filter((option) => option.id !== "thinkingLevel");
  return {
    ...(selection ?? {}),
    options: [
      ...options,
      ...(thinking !== undefined && thinkingLevels.has(thinking)
        ? [{ id: "thinkingLevel", value: thinking }]
        : []),
    ],
  };
};

export const makePiSubagentDriver = Effect.fn("makePiSubagentDriver")(function* (
  input: PiSubagentDriverInput,
): Effect.fn.Return<SubagentDriver, SubagentDriverError> {
  const queue = yield* Queue.unbounded<SubagentObservation, Cause.Done>();
  const events = yield* Queue.unbounded<Effect.Effect<void>, Cause.Done>();
  const workerScope = yield* Scope.make();
  const worker = yield* Effect.forkIn(
    Queue.take(events).pipe(
      Effect.flatMap((event) => event),
      Effect.forever,
    ),
    workerScope,
  );
  const releasedSignal = yield* Deferred.make<void>();
  const { modelSelection, subagent, randomUUID, ...factoryInput } = input;
  const created = yield* createPiSession({
    ...(randomUUID ? { randomUUID } : { randomUUID: Effect.succeed(`pi-${subagent.id}`) }),
    ...factoryInput,
    threadId: subagent.origin.threadId,
    modelSlug: subagent.metadata.model,
    modelSelection: withThinking(modelSelection, subagent.thinking),
    sessionPurpose: "hidden",
    allowedToolNames: ["read", "bash", "edit", "write"],
  }).pipe(
    Effect.mapError(
      (cause) => new SubagentDriverError({ subagentId: subagent.id, message: detail(cause) }),
    ),
  );
  let started = false;
  let terminal = false;
  let disposed = false;
  let released = false;
  let promptFiber: Fiber.Fiber<void, SubagentDriverError> | undefined;
  let unsubscribe: (() => void) | undefined;
  const put = (observation: SubagentObservation) => Queue.offerUnsafe(queue, observation);
  const emit = (kind: SubagentObservation["kind"], text?: string) =>
    Effect.sync(() =>
      put({ subagentId: subagent.id, kind, ...(text === undefined ? {} : { text }) }),
    );
  const release = Effect.fn("PiSubagentDriver.release")(function* () {
    if (released) return;
    released = true;
    unsubscribe?.();
    unsubscribe = undefined;
    if (promptFiber) {
      yield* Fiber.interrupt(promptFiber).pipe(Effect.ignore);
      promptFiber = undefined;
    }
    if (!terminal)
      yield* Effect.tryPromise({
        try: () => created.session.abort(),
        catch: (cause) =>
          new SubagentDriverError({ subagentId: subagent.id, message: detail(cause) }),
      }).pipe(Effect.ignore);
    created.session.dispose();
    yield* Scope.close(created.scope, Exit.void).pipe(Effect.ignore);
    yield* Deferred.succeed(releasedSignal, undefined).pipe(Effect.ignore);
  });
  const dispose: Effect.Effect<void, SubagentDriverError> = Effect.gen(function* () {
    if (disposed) {
      yield* Deferred.await(releasedSignal);
      return;
    }
    disposed = true;
    // Put release before ending the command queue. Queue.end preserves this command.
    yield* Queue.offer(events, release()).pipe(Effect.ignore);
    yield* Queue.end(events).pipe(Effect.ignore);
    yield* Deferred.await(releasedSignal);
    yield* Fiber.join(worker).pipe(Effect.ignore);
    yield* Queue.end(queue).pipe(Effect.ignore);
    yield* Scope.close(workerScope, Exit.void).pipe(Effect.ignore);
  });
  const terminalEmit = (kind: "completed" | "failed" | "stopped", text?: string) => {
    if (terminal) return Effect.void;
    terminal = true;
    return emit(kind, text).pipe(
      // End only after the terminal observation has been enqueued and released.
      Effect.andThen(Queue.end(queue)),
      Effect.andThen(release()),
      Effect.andThen(Queue.end(events)),
    );
  };
  const start = Effect.gen(function* () {
    if (started || terminal) return;
    started = true;
    const session = created.session;
    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "agent_start") Queue.offerUnsafe(events, emit("progress", "Working"));
      if (event.type === "agent_end" && !event.willRetry)
        Queue.offerUnsafe(
          events,
          terminalEmit("completed", session.getLastAssistantText() || undefined),
        );
    });
    yield* emit("started");
    promptFiber = yield* Effect.forkDetach(
      Effect.tryPromise({
        try: () => session.prompt(subagent.prompt),
        catch: (cause) =>
          new SubagentDriverError({ subagentId: subagent.id, message: detail(cause) }),
      }).pipe(
        Effect.catchTag("SubagentDriverError", (error) => terminalEmit("failed", error.message)),
      ),
    );
    yield* Effect.yieldNow;
  });
  const stop = Effect.gen(function* () {
    if (terminal) return;
    yield* Effect.tryPromise({
      try: () => created.session.abort(),
      catch: (cause) =>
        new SubagentDriverError({ subagentId: subagent.id, message: detail(cause) }),
    }).pipe(Effect.ignore);
    yield* Queue.offer(events, terminalEmit("stopped")).pipe(Effect.ignore);
    yield* Deferred.await(releasedSignal);
  });
  return { input: subagent, observations: Stream.fromQueue(queue), start, stop, dispose };
});
