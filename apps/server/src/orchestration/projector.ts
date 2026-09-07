import {
  OrchestrationEvent,
  OrchestrationReadModel,
  SubagentCreatedPayload,
  SubagentAttachedPayload,
  SubagentStartedPayload,
  SubagentProgressedPayload,
  SubagentWaitedPayload,
  SubagentIdledPayload,
  SubagentStopRequestedPayload,
  SubagentCompletedPayload,
  SubagentFailedPayload,
  SubagentStoppedPayload,
  SubagentInterruptedPayload,
  ResultDeliveryQueuedPayload,
  ResultDeliveryAttemptedPayload,
  ResultDeliveryDeliveredPayload,
  ResultDeliveryRetryScheduledPayload,
  ResultDeliveryBlockedPayload,
  ResultDeliveryCancelledPayload,
  type ResultDeliveryStatus,
  ResultDeliveryAttemptId,
  type PulseSubagent,
  type ThreadId,
} from "@t3tools/contracts";
import {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OrchestrationProjectorDecodeError, toProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSettledPayload,
  ThreadPinnedPayload,
  ThreadPinReorderedPayload,
  ThreadSnoozedPayload,
  ThreadUnpinnedPayload,
  ThreadUnarchivedPayload,
  ThreadUnsettledPayload,
  ThreadUnsnoozedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
} from "./Schemas.ts";

const resultDeliveryTransitions: Readonly<
  Record<ResultDeliveryStatus, ReadonlyArray<ResultDeliveryStatus>>
> = {
  queued: ["attempting", "cancelled"],
  attempting: ["delivered", "retry-scheduled", "blocked", "cancelled"],
  "retry-scheduled": ["attempting", "cancelled"],
  blocked: ["attempting", "cancelled"],
  delivered: ["delivered"],
  cancelled: ["cancelled"],
};

const ResultDeliveryPayloads = {
  "result-delivery.queued": ResultDeliveryQueuedPayload,
  "result-delivery.attempted": ResultDeliveryAttemptedPayload,
  "result-delivery.delivered": ResultDeliveryDeliveredPayload,
  "result-delivery.retry-scheduled": ResultDeliveryRetryScheduledPayload,
  "result-delivery.blocked": ResultDeliveryBlockedPayload,
  "result-delivery.cancelled": ResultDeliveryCancelledPayload,
} as const;

const SubagentLifecyclePayloads = {
  "subagent.attached": SubagentAttachedPayload,
  "subagent.started": SubagentStartedPayload,
  "subagent.progressed": SubagentProgressedPayload,
  "subagent.waited": SubagentWaitedPayload,
  "subagent.idled": SubagentIdledPayload,
  "subagent.stop-requested": SubagentStopRequestedPayload,
  "subagent.completed": SubagentCompletedPayload,
  "subagent.failed": SubagentFailedPayload,
  "subagent.stopped": SubagentStoppedPayload,
  "subagent.interrupted": SubagentInterruptedPayload,
} as const;

type SubagentLifecycleType = keyof typeof SubagentLifecyclePayloads;
const terminalSubagentStatuses = new Set<PulseSubagent["status"]>([
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

/**
 * Turn state to settle a still-running latest turn with when its session
 * leaves the "running" status, or null while the session is (re)starting or
 * running and the turn must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSession["status"],
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

function decodeForEvent<A>(
  schema: Schema.Decoder<A, never>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(toProjectorDecodeError(`${eventType}:${field}`)),
  );
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    subagents: [],
    updatedAt: nowIso,
  };
}

function updateResultDelivery(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
  payload: { readonly deliveryId: string },
  patch: {
    readonly status: ResultDeliveryStatus;
    readonly attemptId?: typeof ResultDeliveryAttemptId.Type;
    readonly attemptedAt?: string;
    readonly deliveredAt?: string;
    readonly nextAttemptAt?: string;
    readonly reason?: string;
    readonly diagnostics?: Readonly<Record<string, string>>;
  },
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const subagent = (model.subagents ?? []).find((entry) => entry.id === event.aggregateId);
  const current = subagent?.resultDelivery;
  if (subagent === undefined || current == null || current.deliveryId !== payload.deliveryId) {
    return Effect.fail(
      new OrchestrationProjectorDecodeError({ eventType: event.type, issue: "Unknown delivery" }),
    );
  }
  if (!resultDeliveryTransitions[current.status].includes(patch.status)) {
    return Effect.fail(
      new OrchestrationProjectorDecodeError({
        eventType: event.type,
        issue: `Delivery cannot transition from ${current.status} to ${patch.status}`,
      }),
    );
  }
  if (
    patch.attemptId !== undefined &&
    current.attemptId !== undefined &&
    patch.status !== "attempting" &&
    patch.attemptId !== current.attemptId
  ) {
    return Effect.fail(
      new OrchestrationProjectorDecodeError({
        eventType: event.type,
        issue: "Stale delivery attempt",
      }),
    );
  }
  const resultDelivery = {
    deliveryId: current.deliveryId,
    status: patch.status,
    target: current.target,
    queuedAt: current.queuedAt,
    ...(patch.attemptId === undefined
      ? current.attemptId === undefined
        ? {}
        : { attemptId: current.attemptId }
      : { attemptId: patch.attemptId }),
    ...(patch.attemptedAt === undefined
      ? current.attemptedAt === undefined
        ? {}
        : { attemptedAt: current.attemptedAt }
      : { attemptedAt: patch.attemptedAt }),
    ...(patch.deliveredAt === undefined
      ? current.deliveredAt === undefined
        ? {}
        : { deliveredAt: current.deliveredAt }
      : { deliveredAt: patch.deliveredAt }),
    ...(patch.nextAttemptAt === undefined ? {} : { nextAttemptAt: patch.nextAttemptAt }),
    ...(patch.reason === undefined ? {} : { reason: patch.reason }),
    ...(patch.diagnostics === undefined ? {} : { diagnostics: patch.diagnostics }),
  } satisfies NonNullable<PulseSubagent["resultDelivery"]>;
  return Effect.succeed({
    ...model,
    subagents: model.subagents!.map((entry) =>
      entry.id === subagent.id ? { ...entry, resultDelivery } : entry,
    ),
  });
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "subagent.created":
      return decodeForEvent(SubagentCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          subagents: [
            ...(nextBase.subagents ?? []).filter((subagent) => subagent.id !== payload.subagent.id),
            payload.subagent,
          ],
        })),
      );

    case "subagent.attached":
    case "subagent.started":
    case "subagent.progressed":
    case "subagent.waited":
    case "subagent.idled":
    case "subagent.stop-requested":
    case "subagent.completed":
    case "subagent.failed":
    case "subagent.stopped":
    case "subagent.interrupted": {
      const lifecycleType: SubagentLifecycleType = event.type;
      return decodeForEvent(
        SubagentLifecyclePayloads[lifecycleType],
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.flatMap((payload) =>
          Effect.gen(function* () {
            const subagent = (nextBase.subagents ?? []).find(
              (entry) => entry.id === payload.subagentId,
            );
            if (!subagent) {
              return yield* new OrchestrationProjectorDecodeError({
                eventType: event.type,
                issue: `Unknown subagent ${payload.subagentId}`,
              });
            }
            if (terminalSubagentStatuses.has(subagent.status)) return nextBase;
            if (event.type === "subagent.attached" && subagent.status !== "created") {
              return yield* new OrchestrationProjectorDecodeError({
                eventType: event.type,
                issue: `Subagent ${payload.subagentId} cannot attach from ${subagent.status}`,
              });
            }
            if (event.type === "subagent.started" && subagent.status !== "starting") {
              return yield* new OrchestrationProjectorDecodeError({
                eventType: event.type,
                issue: `Subagent ${payload.subagentId} cannot start from ${subagent.status}`,
              });
            }
            const terminal =
              event.type === "subagent.completed" ||
              event.type === "subagent.failed" ||
              event.type === "subagent.stopped" ||
              event.type === "subagent.interrupted";
            const status = terminal
              ? event.type === "subagent.failed"
                ? "failed"
                : event.type === "subagent.completed"
                  ? "completed"
                  : event.type === "subagent.stopped"
                    ? "stopped"
                    : "interrupted"
              : event.type === "subagent.started"
                ? "running"
                : event.type === "subagent.waited"
                  ? "waiting"
                  : event.type === "subagent.idled"
                    ? "idle"
                    : event.type === "subagent.stop-requested"
                      ? "stop-requested"
                      : subagent.status;
            const updated: PulseSubagent = {
              ...subagent,
              status,
              ...(event.type === "subagent.attached"
                ? { attachedAt: payload.occurredAt, delivery: "attached" as const }
                : {}),
              ...(event.type === "subagent.started"
                ? { startedAt: payload.occurredAt, delivery: "started" as const }
                : {}),
              ...(event.type === "subagent.progressed"
                ? {
                    progress: yield* decodeForEvent(
                      SubagentProgressedPayload,
                      event.payload,
                      event.type,
                      "progress",
                    ).pipe(Effect.map((value) => value.progress)),
                  }
                : {}),
              ...(event.type === "subagent.waited" ? { waitingAt: payload.occurredAt } : {}),
              ...(event.type === "subagent.idled" ? { idleAt: payload.occurredAt } : {}),
              ...(event.type === "subagent.stop-requested"
                ? { stopRequestedAt: payload.occurredAt }
                : {}),
              ...(terminal ? { terminalAt: payload.occurredAt } : {}),
              ...(event.type === "subagent.completed"
                ? { result: (payload as typeof SubagentCompletedPayload.Type).result ?? null }
                : {}),
              ...(event.type === "subagent.failed"
                ? {
                    error: yield* decodeForEvent(
                      SubagentFailedPayload,
                      event.payload,
                      event.type,
                      "error",
                    ).pipe(Effect.map((value) => value.error)),
                  }
                : {}),
            };
            return {
              ...nextBase,
              subagents: (nextBase.subagents ?? []).map((entry) =>
                entry.id === updated.id ? updated : entry,
              ),
            };
          }),
        ),
      );
    }

    case "result-delivery.queued": {
      return decodeForEvent(ResultDeliveryQueuedPayload, event.payload, event.type, "payload").pipe(
        Effect.flatMap((payload) => {
          const subagent = (nextBase.subagents ?? []).find(
            (entry) => entry.id === event.aggregateId,
          );
          if (!subagent)
            return Effect.fail(
              new OrchestrationProjectorDecodeError({
                eventType: event.type,
                issue: "Unknown subagent",
              }),
            );
          if (payload.subagentId !== subagent.id)
            return Effect.fail(
              new OrchestrationProjectorDecodeError({
                eventType: event.type,
                issue: "Mismatched subagent",
              }),
            );
          return Effect.succeed({
            ...nextBase,
            subagents: nextBase.subagents!.map((entry) =>
              entry.id === subagent.id
                ? {
                    ...entry,
                    resultDelivery: {
                      deliveryId: payload.deliveryId,
                      status: "queued" as const,
                      target: payload.target,
                      queuedAt: payload.queuedAt,
                    },
                  }
                : entry,
            ),
          });
        }),
      );
    }
    case "result-delivery.attempted": {
      return decodeForEvent(
        ResultDeliveryAttemptedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.flatMap((payload) =>
          updateResultDelivery(nextBase, event, payload, {
            status: "attempting",
            attemptId: payload.attemptId,
            attemptedAt: payload.attemptedAt,
          }),
        ),
      );
    }
    case "result-delivery.delivered": {
      return decodeForEvent(
        ResultDeliveryDeliveredPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.flatMap((payload) =>
          updateResultDelivery(nextBase, event, payload, {
            status: "delivered",
            attemptId: payload.attemptId,
            deliveredAt: payload.deliveredAt,
            ...(payload.diagnostics === undefined ? {} : { diagnostics: payload.diagnostics }),
          }),
        ),
      );
    }
    case "result-delivery.retry-scheduled": {
      return decodeForEvent(
        ResultDeliveryRetryScheduledPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.flatMap((payload) =>
          updateResultDelivery(nextBase, event, payload, {
            status: "retry-scheduled",
            attemptId: payload.attemptId,
            nextAttemptAt: payload.nextAttemptAt,
            reason: payload.reason,
          }),
        ),
      );
    }
    case "result-delivery.blocked": {
      return decodeForEvent(
        ResultDeliveryBlockedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.flatMap((payload) =>
          updateResultDelivery(nextBase, event, payload, {
            status: "blocked",
            ...(payload.attemptId === undefined ? {} : { attemptId: payload.attemptId }),
            reason: payload.reason,
            ...(payload.diagnostics === undefined ? {} : { diagnostics: payload.diagnostics }),
          }),
        ),
      );
    }
    case "result-delivery.cancelled": {
      return decodeForEvent(
        ResultDeliveryCancelledPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.flatMap((payload) =>
          updateResultDelivery(nextBase, event, payload, {
            status: "cancelled",
            ...(payload.reason === undefined ? {} : { reason: payload.reason }),
          }),
        ),
      );
    }
    /* legacy implementation removed */
    /* const payloadSchema = ResultDeliveryPayloads[event.type];
      return decodeForEvent(payloadSchema, event.payload, event.type, "payload").pipe(
        Effect.flatMap((payload) => {
          const subagentId = "subagentId" in payload ? payload.subagentId : undefined;
          const subagent = (nextBase.subagents ?? []).find((entry) => entry.id === subagentId);
          if (!subagent) return Effect.fail(new OrchestrationProjectorDecodeError({ eventType: event.type, issue: "Unknown subagent" }));
          const current = subagent.resultDelivery;
          if (event.type === "result-delivery.queued") {
            return Effect.succeed({ ...nextBase, subagents: nextBase.subagents!.map((entry) => entry.id === subagent.id ? { ...entry, resultDelivery: { deliveryId: payload.deliveryId, status: "queued" as const, target: payload.target, queuedAt: payload.queuedAt } } : entry) });
          }
          if (!current || current.deliveryId !== payload.deliveryId) return Effect.fail(new OrchestrationProjectorDecodeError({ eventType: event.type, issue: "Unknown delivery" }));
          const patch = event.type === "result-delivery.attempted" ? { status: "attempting" as const, attemptId: payload.attemptId, attemptedAt: payload.attemptedAt } : event.type === "result-delivery.delivered" ? { status: "delivered" as const, attemptId: payload.attemptId, deliveredAt: payload.deliveredAt, ...(payload.diagnostics === undefined ? {} : { diagnostics: payload.diagnostics }) } : event.type === "result-delivery.retry-scheduled" ? { status: "retry-scheduled" as const, attemptId: payload.attemptId, nextAttemptAt: payload.nextAttemptAt, reason: payload.reason } : event.type === "result-delivery.blocked" ? { status: "blocked" as const, ...(payload.attemptId === undefined ? {} : { attemptId: payload.attemptId }), reason: payload.reason, ...(payload.diagnostics === undefined ? {} : { diagnostics: payload.diagnostics }) } : { status: "cancelled" as const, reason: payload.reason };
          return Effect.succeed({ ...nextBase, subagents: nextBase.subagents!.map((entry) => entry.id === subagent.id ? { ...entry, resultDelivery: { ...current, ...patch } } : entry) });
        }),
      );
    } */

    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            defaultThreadEnvMode: null,
            faviconPath: payload.faviconPath ?? null,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.defaultThreadEnvMode !== undefined
                    ? { defaultThreadEnvMode: payload.defaultThreadEnvMode }
                    : {}),
                  ...(payload.faviconPath !== undefined
                    ? { faviconPath: payload.faviconPath }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            deletedAt: null,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            titleRegeneration: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.settled":
      return decodeForEvent(ThreadSettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: "settled",
            settledAt: payload.settledAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsettled":
      return decodeForEvent(ThreadUnsettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: payload.reason === "user" ? "active" : null,
            settledAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.snoozed":
      return decodeForEvent(ThreadSnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: payload.snoozedUntil,
            snoozedAt: payload.snoozedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unsnoozed":
      return decodeForEvent(ThreadUnsnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pinned":
      return decodeForEvent(ThreadPinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: payload.pinnedAt,
            ...(payload.pinOrderKey !== undefined ? { pinOrderKey: payload.pinOrderKey } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unpinned":
      return decodeForEvent(ThreadUnpinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: null,
            // Unpin clears the slot: re-pinning is "pin again", not "restore
            // an ancient position".
            pinOrderKey: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.pin-reordered":
      return decodeForEvent(ThreadPinReorderedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinOrderKey: payload.orderKey,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.titleRegeneration !== undefined
              ? { titleRegeneration: payload.titleRegeneration }
              : {}),
            ...(payload.modelSelection !== undefined
              ? { modelSelection: payload.modelSelection }
              : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        // Leaving the "running" session status is the turn-end signal: settle
        // a still-running latest turn so its duration reflects the whole turn.
        const settledTurnState = settledTurnStateForSessionStatus(session.status);
        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                  }
                : thread.latestTurn !== null &&
                    thread.latestTurn.state === "running" &&
                    settledTurnState !== null
                  ? {
                      ...thread.latestTurn,
                      state: settledTurnState,
                      // A running turn's completedAt can only hold a mid-turn
                      // placeholder checkpoint timestamp — the session leaving
                      // "running" is the authoritative turn end.
                      completedAt: session.updatedAt,
                    }
                  : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        // Mid-turn diff updates produce placeholder checkpoints; record the
        // checkpoint, but don't settle a turn its session is still running.
        const turnStillRunning =
          thread.session?.status === "running" && thread.session.activeTurnId === payload.turnId;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: turnStillRunning
              ? thread.latestTurn
              : {
                  turnId: payload.turnId,
                  state: checkpointStatusToLatestTurnState(payload.status),
                  requestedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? thread.latestTurn.requestedAt
                      : payload.completedAt,
                  startedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? (thread.latestTurn.startedAt ?? payload.completedAt)
                      : payload.completedAt,
                  completedAt: payload.completedAt,
                  assistantMessageId: payload.assistantMessageId,
                },
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareThreadActivities)
            .slice(-500);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
