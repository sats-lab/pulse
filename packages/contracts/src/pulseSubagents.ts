import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TurnId,
  TrimmedNonEmptyString,
  NonNegativeInt,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const SubagentId = TrimmedNonEmptyString.pipe(Schema.brand("SubagentId"));
export type SubagentId = typeof SubagentId.Type;
export const SubagentOrigin = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  turnId: TurnId,
});
export type SubagentOrigin = typeof SubagentOrigin.Type;
export const SubagentMetadata = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export type SubagentMetadata = typeof SubagentMetadata.Type;

export const PulseSubagentStatus = Schema.Literals([
  "created",
  "starting",
  "running",
  "waiting",
  "idle",
  "stop-requested",
  "completed",
  "failed",
  "stopped",
  "interrupted",
]);
export type PulseSubagentStatus = typeof PulseSubagentStatus.Type;
export const PulseSubagent = Schema.Struct({
  id: SubagentId,
  /** Legacy records may omit this field; such records are not executable. */
  title: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("Untitled subagent")),
  ),
  /** Legacy records may omit this field; an empty decoded prompt is never executable. */
  prompt: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  origin: SubagentOrigin,
  metadata: SubagentMetadata,
  /** Provider-neutral reasoning controls; Pi maps thinking to its thinking level. */
  thinking: Schema.optional(
    Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  ),
  effort: Schema.optional(TrimmedNonEmptyString),
  status: PulseSubagentStatus.pipe(Schema.withDecodingDefault(Effect.succeed("created" as const))),
  delivery: Schema.Literals(["none", "attached", "started"]),
  createdAt: IsoDateTime,
  attachedAt: Schema.optional(IsoDateTime),
  startedAt: Schema.optional(IsoDateTime),
  progress: Schema.optional(TrimmedNonEmptyString),
  waitingAt: Schema.optional(IsoDateTime),
  idleAt: Schema.optional(IsoDateTime),
  stopRequestedAt: Schema.optional(IsoDateTime),
  terminalAt: Schema.optional(IsoDateTime),
  error: Schema.optional(TrimmedNonEmptyString),
  /** Durable final text; null means the run completed without assistant text. */
  result: Schema.optional(Schema.NullOr(Schema.String)),
  resultDelivery: Schema.optional(Schema.NullOr(Schema.suspend(() => ResultDelivery))),
});
export type PulseSubagent = typeof PulseSubagent.Type;

const ExecutableSubagent = Schema.Struct({
  ...PulseSubagent.fields,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
});
export const isExecutablePulseSubagent = (subagent: PulseSubagent): boolean =>
  subagent.prompt.trim().length > 0 && subagent.title.trim().length > 0;

const lifecycleFields = {
  commandId: CommandId,
  subagentId: SubagentId,
  createdAt: IsoDateTime,
} as const;
const LifecycleCommand = <T extends string>(type: T) =>
  Schema.Struct({ type: Schema.Literal(type), ...lifecycleFields });
export const SubagentCreateCommand = Schema.Struct({
  type: Schema.Literal("subagent.create"),
  commandId: CommandId,
  subagentId: SubagentId,
  subagent: ExecutableSubagent,
});
export const SubagentAttachCommand = LifecycleCommand("subagent.attach");
export const SubagentStartCommand = LifecycleCommand("subagent.start");
export const SubagentProgressCommand = Schema.Struct({
  type: Schema.Literal("subagent.progress"),
  ...lifecycleFields,
  progress: TrimmedNonEmptyString,
});
export const SubagentWaitCommand = LifecycleCommand("subagent.wait");
export const SubagentIdleCommand = LifecycleCommand("subagent.idle");
export const SubagentStopRequestCommand = LifecycleCommand("subagent.stop-request");
export const SubagentCompleteCommand = Schema.Struct({
  type: Schema.Literal("subagent.complete"),
  ...lifecycleFields,
  result: Schema.NullOr(Schema.String),
});
export const SubagentFailCommand = Schema.Struct({
  type: Schema.Literal("subagent.fail"),
  ...lifecycleFields,
  error: TrimmedNonEmptyString,
});
export const SubagentStopCommand = LifecycleCommand("subagent.stop");
export const SubagentInterruptCommand = LifecycleCommand("subagent.interrupt");

export const ResultDeliveryId = TrimmedNonEmptyString.pipe(Schema.brand("ResultDeliveryId"));
export type ResultDeliveryId = typeof ResultDeliveryId.Type;
export const ResultDeliveryAttemptId = TrimmedNonEmptyString.pipe(
  Schema.brand("ResultDeliveryAttemptId"),
);
export type ResultDeliveryAttemptId = typeof ResultDeliveryAttemptId.Type;
export const ResultDeliveryStatus = Schema.Literals([
  "queued",
  "attempting",
  "retry-scheduled",
  "delivered",
  "blocked",
  "cancelled",
]);
export type ResultDeliveryStatus = typeof ResultDeliveryStatus.Type;
export const ResultDeliveryTarget = Schema.Struct({
  kind: TrimmedNonEmptyString,
  address: Schema.optional(TrimmedNonEmptyString),
});
export type ResultDeliveryTarget = typeof ResultDeliveryTarget.Type;
export const ResultDelivery = Schema.Struct({
  deliveryId: ResultDeliveryId,
  status: ResultDeliveryStatus,
  target: ResultDeliveryTarget,
  queuedAt: IsoDateTime,
  attemptId: Schema.optional(ResultDeliveryAttemptId),
  attemptedAt: Schema.optional(IsoDateTime),
  deliveredAt: Schema.optional(IsoDateTime),
  nextAttemptAt: Schema.optional(IsoDateTime),
  reason: Schema.optional(TrimmedNonEmptyString),
  diagnostics: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type ResultDelivery = typeof ResultDelivery.Type;
export const ResultDeliveryAttemptCommand = Schema.Struct({
  type: Schema.Literal("result-delivery.attempt"),
  commandId: CommandId,
  subagentId: SubagentId,
  deliveryId: ResultDeliveryId,
  attemptId: ResultDeliveryAttemptId,
  createdAt: IsoDateTime,
});
export const ResultDeliveryDeliverCommand = Schema.Struct({
  type: Schema.Literal("result-delivery.deliver"),
  commandId: CommandId,
  subagentId: SubagentId,
  deliveryId: ResultDeliveryId,
  attemptId: ResultDeliveryAttemptId,
  createdAt: IsoDateTime,
  diagnostics: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export const ResultDeliveryRetryCommand = Schema.Struct({
  type: Schema.Literal("result-delivery.retry"),
  commandId: CommandId,
  subagentId: SubagentId,
  deliveryId: ResultDeliveryId,
  attemptId: ResultDeliveryAttemptId,
  createdAt: IsoDateTime,
  nextAttemptAt: IsoDateTime,
  reason: TrimmedNonEmptyString,
});
export const ResultDeliveryBlockCommand = Schema.Struct({
  type: Schema.Literal("result-delivery.block"),
  commandId: CommandId,
  subagentId: SubagentId,
  deliveryId: ResultDeliveryId,
  attemptId: Schema.optional(ResultDeliveryAttemptId),
  createdAt: IsoDateTime,
  reason: TrimmedNonEmptyString,
  diagnostics: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export const ResultDeliveryCancelCommand = Schema.Struct({
  type: Schema.Literal("result-delivery.cancel"),
  commandId: CommandId,
  subagentId: SubagentId,
  deliveryId: ResultDeliveryId,
  createdAt: IsoDateTime,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export const ResultDeliveryQueuedPayload = Schema.Struct({
  deliveryId: ResultDeliveryId,
  subagentId: SubagentId,
  target: ResultDeliveryTarget,
  queuedAt: IsoDateTime,
});
export const ResultDeliveryAttemptedPayload = Schema.Struct({
  deliveryId: ResultDeliveryId,
  attemptId: ResultDeliveryAttemptId,
  attemptedAt: IsoDateTime,
});
export const ResultDeliveryDeliveredPayload = Schema.Struct({
  deliveryId: ResultDeliveryId,
  attemptId: ResultDeliveryAttemptId,
  deliveredAt: IsoDateTime,
  diagnostics: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export const ResultDeliveryRetryScheduledPayload = Schema.Struct({
  deliveryId: ResultDeliveryId,
  attemptId: ResultDeliveryAttemptId,
  nextAttemptAt: IsoDateTime,
  reason: TrimmedNonEmptyString,
});
export const ResultDeliveryBlockedPayload = Schema.Struct({
  deliveryId: ResultDeliveryId,
  attemptId: Schema.optional(ResultDeliveryAttemptId),
  blockedAt: IsoDateTime,
  reason: TrimmedNonEmptyString,
  diagnostics: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export const ResultDeliveryCancelledPayload = Schema.Struct({
  deliveryId: ResultDeliveryId,
  cancelledAt: IsoDateTime,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export const SubagentCreatedPayload = Schema.Struct({ subagent: PulseSubagent });
export type SubagentCreatedPayload = typeof SubagentCreatedPayload.Type;

const idPayload = (type: string) =>
  Schema.Struct({ subagentId: SubagentId, occurredAt: IsoDateTime });
export const SubagentAttachedPayload = idPayload("attached");
export const SubagentStartedPayload = idPayload("started");
export const SubagentProgressedPayload = Schema.Struct({
  subagentId: SubagentId,
  progress: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
});
export const SubagentWaitedPayload = idPayload("waited");
export const SubagentIdledPayload = idPayload("idled");
export const SubagentStopRequestedPayload = idPayload("stop-requested");
export const SubagentCompletedPayload = Schema.Struct({
  subagentId: SubagentId,
  result: Schema.optional(Schema.NullOr(Schema.String)),
  occurredAt: IsoDateTime,
});
export const SubagentFailedPayload = Schema.Struct({
  subagentId: SubagentId,
  error: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
});
export const SubagentStoppedPayload = idPayload("stopped");
export const SubagentInterruptedPayload = idPayload("interrupted");
