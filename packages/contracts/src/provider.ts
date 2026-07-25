import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderInputQueueMutation,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";
import { ServerProviderSlashCommandInput } from "./server.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
  midTurnInputMode: Schema.optional(Schema.Literals(["steer", "followUp"])),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderDiscoveryInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  forceReload: Schema.optional(Schema.Boolean),
});
export type ProviderDiscoveryInput = typeof ProviderDiscoveryInput.Type;

export const ProviderDiscoveryDiagnostic = Schema.Struct({
  severity: Schema.Literals(["warning", "error"]),
  message: TrimmedNonEmptyString,
  path: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderDiscoveryDiagnostic = typeof ProviderDiscoveryDiagnostic.Type;

export const ProviderListSkillsResult = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      description: Schema.optional(TrimmedNonEmptyString),
      path: Schema.optional(TrimmedNonEmptyString),
      enabled: Schema.optional(Schema.Boolean),
      scope: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  source: TrimmedNonEmptyString,
  cached: Schema.Boolean,
  diagnostics: Schema.optional(Schema.Array(ProviderDiscoveryDiagnostic)),
});
export type ProviderListSkillsResult = typeof ProviderListSkillsResult.Type;

export const ProviderListCommandsResult = Schema.Struct({
  commands: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      description: Schema.optional(TrimmedNonEmptyString),
      input: Schema.optional(ServerProviderSlashCommandInput),
    }),
  ),
  source: TrimmedNonEmptyString,
  cached: Schema.Boolean,
  diagnostics: Schema.optional(Schema.Array(ProviderDiscoveryDiagnostic)),
});
export type ProviderListCommandsResult = typeof ProviderListCommandsResult.Type;

export const ProviderComposerCapabilities = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  supportsSkillMentions: Schema.Boolean,
  supportsSkillDiscovery: Schema.Boolean,
  supportsNativeSlashCommandDiscovery: Schema.Boolean,
});
export type ProviderComposerCapabilities = typeof ProviderComposerCapabilities.Type;

export class ProviderDiscoveryError extends Schema.TaggedErrorClass<ProviderDiscoveryError>()(
  "ProviderDiscoveryError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider discovery failed in ${this.operation}: ${this.detail}`;
  }
}

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderMutateInputQueueInput = Schema.Struct({
  threadId: ThreadId,
  mutation: ProviderInputQueueMutation,
});
export type ProviderMutateInputQueueInput = typeof ProviderMutateInputQueueInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
