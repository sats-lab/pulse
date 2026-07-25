import {
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type PiSettings,
  type ProviderInstanceId as ProviderInstanceIdType,
  type ProviderRuntimeEvent,
  type ProviderDiscoveryDiagnostic,
  type ProviderListCommandsResult,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  createAgentSession,
  createAgentSessionServices,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionResult,
  type AgentSessionServices,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { PI_SLASH_COMMANDS, piSkillToServerProviderSkill } from "../Layers/PiProvider.ts";
import {
  makePiToolTextProjector,
  projectPiToolResult,
  type PiToolTextProjection,
  type PiToolTextProjector,
} from "./PiToolOutputProjector.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
type PiToolItemType = "command_execution" | "file_change" | "dynamic_tool_call" | "web_search";

interface PiResumeCursor {
  readonly sessionFile: string;
  readonly sessionId: string;
}

interface PiTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  leafId?: string | null;
}

interface PiDeferredUserMessage {
  readonly mode: "steer" | "followUp";
  readonly text: string;
  readonly images: Array<{
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
  }>;
  source: "native" | "compaction";
}

type PiQueuedDuringCompactionInput = PiDeferredUserMessage;

interface PiActiveTool {
  readonly turnId: TurnId | undefined;
  readonly toolName: string;
  readonly args: unknown;
  readonly itemType: PiToolItemType;
  readonly textProjector: PiToolTextProjector;
}

interface PiTurnFailure {
  readonly state: "failed" | "interrupted";
  readonly message: string;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly piSession: AgentSession;
  readonly scope: Scope.Closeable;
  readonly unsubscribe: () => void;
  readonly stopped: Ref.Ref<boolean>;
  readonly turns: Array<PiTurnSnapshot>;
  readonly activeTools: Map<string, PiActiveTool>;
  readonly deferredUserMessages: Array<PiDeferredUserMessage>;
  readonly queuedDuringCompaction: Array<PiQueuedDuringCompactionInput>;
  readonly queueSemaphore: Semaphore.Semaphore;
  suppressQueueUpdates: boolean;
  activeTurnId: TurnId | undefined;
  activeCompactionTurnId: TurnId | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  compactionDrainFiber: Fiber.Fiber<void, never> | undefined;
  activeAssistantItemId: string | undefined;
  activeReasoningItemId: string | undefined;
  activeTurnFailure: PiTurnFailure | undefined;
  nextAssistantMessageIndex: number;
}

export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceIdType;
  readonly modelRuntime: ModelRuntime;
  readonly environment: Record<string, string>;
  readonly createAgentSession?: (
    options: Parameters<typeof createAgentSession>[0],
  ) => Promise<CreateAgentSessionResult>;
  readonly createAgentSessionServices?: (
    options: Parameters<typeof createAgentSessionServices>[0],
  ) => Promise<AgentSessionServices>;
}

export type PiAdapterEnv = Crypto.Crypto | FileSystem.FileSystem | ServerConfig;

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePiCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "");
}

function piDiscoveryDiagnostics(
  diagnostics: ReadonlyArray<{
    readonly type: "warning" | "error" | "collision";
    readonly message: string;
    readonly path?: string | undefined;
  }>,
): ReadonlyArray<ProviderDiscoveryDiagnostic> {
  return diagnostics.flatMap((diagnostic) => {
    const message = trimToUndefined(diagnostic.message);
    if (!message) return [];
    const path = trimToUndefined(diagnostic.path);
    return [
      {
        severity: diagnostic.type === "error" ? "error" : "warning",
        message,
        ...(path ? { path } : {}),
      },
    ];
  });
}

function expandPiSkillMentions(
  text: string,
  skills: ReadonlyArray<{ readonly name: string }>,
): string {
  if (!text.includes("$")) return text;
  const names = new Set(skills.map((skill) => skill.name));
  for (const match of text.matchAll(/(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g)) {
    const name = match[2];
    if (!name || !names.has(name)) continue;
    const prefixLength = match[1]?.length ?? 0;
    const tokenStart = (match.index ?? 0) + prefixLength;
    const tokenEnd = tokenStart + name.length + 1;
    const before = text.slice(0, tokenStart).trimEnd();
    const after = text.slice(tokenEnd).trimStart();
    const argumentsText = [before, after].filter((part) => part.length > 0).join(" ");
    return `/skill:${name}${argumentsText ? ` ${argumentsText}` : ""}`;
  }
  return text;
}

type PiDiscoveredCommand = ProviderListCommandsResult["commands"][number];

function dedupePiCommands(
  groups: ReadonlyArray<ReadonlyArray<PiDiscoveredCommand>>,
): ReadonlyArray<PiDiscoveredCommand> {
  const commands: PiDiscoveredCommand[] = [];
  const names = new Set<string>();
  for (const group of groups) {
    for (const command of group) {
      const name = normalizePiCommandName(command.name);
      if (name.length === 0 || names.has(name)) continue;
      names.add(name);
      commands.push({ ...command, name });
    }
  }
  return commands;
}

function parsePiModelSlug(slug: string | undefined): { provider: string; modelId: string } | null {
  if (!slug) return null;
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

async function resolvePiModel(
  modelRuntime: ModelRuntime,
  slug: string | undefined,
  environment: Record<string, string>,
): Promise<PiModel | undefined> {
  const parsed = parsePiModelSlug(slug);
  const model = parsed
    ? modelRuntime.getModel(parsed.provider, parsed.modelId)
    : (await modelRuntime.getAvailable())[0];
  if (!model) return undefined;
  const auth = await modelRuntime.getAuth(model, { env: environment });
  return auth ? model : undefined;
}

function resolveThinkingLevel(input: {
  readonly modelSelection?:
    | {
        readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
      }
    | undefined;
}): AgentSession["thinkingLevel"] | undefined {
  const value = input.modelSelection?.options?.find(
    (option) => option.id === "thinkingLevel",
  )?.value;
  return typeof value === "string" ? (value as AgentSession["thinkingLevel"]) : undefined;
}

function extractResumeSessionFile(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const record = recordFromUnknown(value);
  for (const key of ["sessionFile", "sessionFilePath", "nativeHandle", "path"]) {
    const candidate = record?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}

function buildResumeCursor(session: AgentSession): PiResumeCursor | undefined {
  const sessionFile = session.sessionManager.getSessionFile();
  if (!sessionFile) return undefined;
  return { sessionFile, sessionId: session.sessionManager.getSessionId() };
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getPiMessageRole(message: unknown): string | undefined {
  const role = recordFromUnknown(message)?.role;
  return typeof role === "string" ? role : undefined;
}

function getPiMessageText(message: unknown): string | undefined {
  const content = recordFromUnknown(message)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((entry) => {
      const record = recordFromUnknown(entry);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function takeDeferredUserMessage(context: PiSessionContext, text: string): boolean {
  const exactIndex = context.deferredUserMessages.findIndex((message) => message.text === text);
  if (exactIndex !== -1) {
    context.deferredUserMessages.splice(exactIndex, 1);
    return true;
  }
  if (context.deferredUserMessages.length > 0) {
    context.deferredUserMessages.shift();
    return true;
  }
  return false;
}

function deferredMessagesByMode(
  context: PiSessionContext,
  mode: "steer" | "followUp",
): Array<PiDeferredUserMessage> {
  return context.deferredUserMessages.filter(
    (message) => message.mode === mode && message.source === "native",
  );
}

function removeDeferredMessage(context: PiSessionContext, message: PiDeferredUserMessage): void {
  const index = context.deferredUserMessages.indexOf(message);
  if (index !== -1) context.deferredUserMessages.splice(index, 1);
}

function queuedDuringCompactionTexts(
  context: PiSessionContext,
  mode: "steer" | "followUp",
): Array<string> {
  return context.queuedDuringCompaction
    .filter((message) => message.mode === mode)
    .map((message) => message.text);
}

function getPiAssistantStopReason(message: unknown): string | undefined {
  if (getPiMessageRole(message) !== "assistant") return undefined;
  const stopReason = recordFromUnknown(message)?.stopReason;
  return typeof stopReason === "string" ? stopReason : undefined;
}

function getPiAssistantErrorMessage(message: unknown): string | undefined {
  if (getPiMessageRole(message) !== "assistant") return undefined;
  const error = recordFromUnknown(message)?.errorMessage;
  return typeof error === "string" && error.trim().length > 0 ? error.trim() : undefined;
}

function findTerminalError(messages: ReadonlyArray<unknown>): PiTurnFailure | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (getPiMessageRole(message) !== "assistant") continue;
    const stopReason = getPiAssistantStopReason(message);
    if (stopReason !== "error" && stopReason !== "aborted") return undefined;
    return {
      state: stopReason === "aborted" ? "interrupted" : "failed",
      message:
        getPiAssistantErrorMessage(message) ??
        (stopReason === "aborted" ? "Pi request was aborted." : "Pi provider returned an error."),
    };
  }
  return undefined;
}

function ensureTurn(context: PiSessionContext, turnId: TurnId | undefined): void {
  if (!turnId || context.turns.some((turn) => turn.id === turnId)) return;
  context.turns.push({ id: turnId, items: [] });
}

function appendTurnItem(
  context: PiSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) return;
  ensureTurn(context, turnId);
  context.turns.find((turn) => turn.id === turnId)?.items.push(item);
}

function recordTurnLeaf(context: PiSessionContext, turnId: TurnId | undefined): void {
  if (!turnId) return;
  const turn = context.turns.find((candidate) => candidate.id === turnId);
  if (turn) turn.leafId = context.piSession.sessionManager.getLeafId();
}

function toToolItemType(toolName: string): PiToolItemType {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" || normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized === "edit" ||
    normalized === "write" ||
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch")
  ) {
    return "file_change";
  }
  if (normalized === "grep" || normalized === "find" || normalized.includes("search")) {
    return "web_search";
  }
  return "dynamic_tool_call";
}

function firstStringValue(
  record: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function buildToolTitle(toolName: string, args: unknown): string {
  const record = recordFromUnknown(args);
  const command = firstStringValue(record, ["command", "cmd"]);
  if (command && toToolItemType(toolName) === "command_execution") return command;
  const path = firstStringValue(record, ["path", "filePath", "file", "relativePath"]);
  if (path) return `${toolName} ${path}`;
  const query = firstStringValue(record, ["pattern", "query"]);
  return query ? `${toolName} ${query}` : toolName;
}

function toolStreamKind(
  itemType: PiToolItemType,
): "command_output" | "file_change_output" | "unknown" {
  if (itemType === "command_execution") return "command_output";
  if (itemType === "file_change") return "file_change_output";
  return "unknown";
}

function readToolText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  const record = recordFromUnknown(result);
  const direct = firstStringValue(record, [
    "output",
    "stdout",
    "stderr",
    "text",
    "summary",
    "message",
    "error",
  ]);
  if (direct) return direct;
  const content = Array.isArray(record?.content) ? record.content : [];
  const text = content
    .flatMap((entry) => {
      const block = recordFromUnknown(entry);
      return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function readToolSnapshot(result: unknown) {
  const record = recordFromUnknown(result);
  const details = recordFromUnknown(record?.details);
  const truncation = recordFromUnknown(details?.truncation);
  return {
    text: readToolText(result),
    totalBytes:
      typeof truncation?.totalBytes === "number" && Number.isFinite(truncation.totalBytes)
        ? truncation.totalBytes
        : undefined,
    truncated: truncation?.truncated === true,
  };
}

function projectToolMetadata(result: unknown): ReturnType<typeof projectPiToolResult> {
  const projected = projectPiToolResult(result);
  if (!projected) return undefined;
  return projected.details === undefined ? undefined : { details: projected.details };
}

function readToolExitCode(result: unknown): number | null | undefined {
  const record = recordFromUnknown(result);
  const details = recordFromUnknown(record?.details);
  for (const source of [record, details]) {
    for (const key of ["exitCode", "code"]) {
      const value = source?.[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return undefined;
}

function buildToolData(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly outputProjection?: PiToolTextProjection;
  readonly projectedResult?: ReturnType<typeof projectPiToolResult>;
  readonly result?: unknown;
  readonly isError?: boolean;
}): Record<string, unknown> {
  const exitCode = readToolExitCode(input.result);
  return {
    toolCallId: input.toolCallId,
    callId: input.toolCallId,
    toolName: input.toolName,
    name: input.toolName,
    input: input.args,
    ...(input.outputProjection && input.outputProjection.kind !== "none"
      ? { outputProjection: input.outputProjection }
      : {}),
    ...(input.projectedResult ? { result: input.projectedResult } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(input.isError !== undefined ? { isError: input.isError } : {}),
  };
}

function classifyRuntimeError(
  message: string,
): "provider_error" | "transport_error" | "permission_error" | "validation_error" | "unknown" {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("network") ||
    normalized.includes("connection") ||
    normalized.includes("timeout") ||
    normalized.includes("econn") ||
    normalized.includes("fetch failed")
  )
    return "transport_error";
  if (
    normalized.includes("api key") ||
    normalized.includes("auth") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("permission")
  )
    return "permission_error";
  if (
    normalized.includes("invalid") ||
    normalized.includes("validation") ||
    normalized.includes("not available")
  )
    return "validation_error";
  if (
    normalized.includes("rate limit") ||
    normalized.includes("quota") ||
    normalized.includes("provider")
  )
    return "provider_error";
  return "unknown";
}

function normalizeTokenUsage(
  stats: ReturnType<AgentSession["getSessionStats"]>,
  fallbackContextWindow?: number | null,
): ThreadTokenUsageSnapshot | undefined {
  const inputTokens = Math.max(0, Math.round(stats.tokens.input));
  const cachedInputTokens = Math.max(0, Math.round(stats.tokens.cacheRead));
  const outputTokens = Math.max(0, Math.round(stats.tokens.output));
  const totalProcessedTokens = Math.max(0, Math.round(stats.tokens.total));
  const contextWindow =
    typeof stats.contextUsage?.contextWindow === "number" && stats.contextUsage.contextWindow > 0
      ? Math.round(stats.contextUsage.contextWindow)
      : typeof fallbackContextWindow === "number" && fallbackContextWindow > 0
        ? Math.round(fallbackContextWindow)
        : undefined;
  const contextUsageTokens =
    typeof stats.contextUsage?.tokens === "number" && stats.contextUsage.tokens >= 0
      ? Math.round(stats.contextUsage.tokens)
      : undefined;
  const usedTokens =
    contextUsageTokens ??
    (contextWindow ? Math.min(totalProcessedTokens, contextWindow) : totalProcessedTokens);
  if (usedTokens <= 0 && totalProcessedTokens <= 0 && contextWindow === undefined) return undefined;
  return {
    usedTokens,
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    ...(contextWindow !== undefined ? { maxTokens: contextWindow } : {}),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
    toolUses: stats.toolCalls,
    compactsAutomatically: true,
  };
}

export interface PiEventProjectionState {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly instanceId: ProviderInstanceIdType;
  readonly nextEventBase: (input?: {
    readonly itemId?: string;
    readonly raw?: unknown;
  }) => Omit<ProviderRuntimeEvent, "type" | "payload">;
  readonly activeTools: Map<string, PiActiveTool>;
  readonly nextAssistantItemId: () => string;
  readonly nextReasoningItemId: () => string;
}

/**
 * Normalize one Pi 0.82 AgentSession event. Keeping this projector pure makes
 * the full SDK union characterizable without starting a live model session.
 */
export function projectPiSessionEvent(
  state: PiEventProjectionState,
  event: AgentSessionEvent,
): ReadonlyArray<ProviderRuntimeEvent> {
  const base = (itemId?: string) =>
    state.nextEventBase({ ...(itemId ? { itemId } : {}), raw: event });
  const withItemId = (eventBase: ReturnType<typeof base>, itemId: string) => ({
    ...eventBase,
    itemId: RuntimeItemId.make(itemId),
  });
  const toolRefs = (toolCallId: string) => ({
    providerRefs: { providerItemId: ProviderItemId.make(toolCallId) },
  });

  switch (event.type) {
    case "message_start": {
      if (getPiMessageRole(event.message) !== "assistant") return [];
      const itemId = state.nextAssistantItemId();
      return [
        {
          ...withItemId(base(itemId), itemId),
          type: "item.started",
          payload: {
            itemType: "assistant_message",
            status: "inProgress",
            title: "Assistant message",
          },
        },
      ];
    }
    case "message_update": {
      const update = event.assistantMessageEvent;
      if (update.type !== "text_delta" && update.type !== "thinking_delta") return [];
      if (update.delta.length === 0) return [];
      const reasoning = update.type === "thinking_delta";
      const itemId = reasoning ? state.nextReasoningItemId() : state.nextAssistantItemId();
      return [
        {
          ...withItemId(base(itemId), itemId),
          type: "content.delta",
          payload: {
            streamKind: reasoning ? "reasoning_text" : "assistant_text",
            delta: update.delta,
            ...(typeof update.contentIndex === "number"
              ? { contentIndex: update.contentIndex }
              : {}),
          },
        },
      ];
    }
    case "message_end": {
      if (getPiMessageRole(event.message) !== "assistant") return [];
      const itemId = state.nextAssistantItemId();
      const stopReason = getPiAssistantStopReason(event.message);
      const errorMessage = getPiAssistantErrorMessage(event.message);
      const detail = getPiMessageText(event.message) ?? errorMessage;
      return [
        {
          ...withItemId(base(itemId), itemId),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: stopReason === "error" ? "failed" : "completed",
            title: "Assistant message",
            ...(detail ? { detail } : {}),
            data: {
              ...(stopReason ? { stopReason } : {}),
              ...(errorMessage ? { errorMessage } : {}),
            },
          },
        },
      ];
    }
    case "tool_execution_start": {
      const itemType = toToolItemType(event.toolName);
      state.activeTools.set(event.toolCallId, {
        turnId: state.turnId,
        toolName: event.toolName,
        args: event.args,
        itemType,
        textProjector: makePiToolTextProjector(),
      });
      return [
        {
          ...withItemId(base(event.toolCallId), event.toolCallId),
          ...toolRefs(event.toolCallId),
          type: "item.started",
          payload: {
            itemType,
            status: "inProgress",
            title: buildToolTitle(event.toolName, event.args),
            data: buildToolData({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            }),
          },
        },
      ];
    }
    case "tool_execution_update": {
      const active = state.activeTools.get(event.toolCallId);
      const itemType = active?.itemType ?? toToolItemType(event.toolName);
      const projection = active?.textProjector.project(readToolSnapshot(event.partialResult));
      const result = projectToolMetadata(event.partialResult);
      const events: Array<ProviderRuntimeEvent> = [];
      if (projection?.kind === "append" && projection.text.length > 0) {
        events.push({
          ...withItemId(base(event.toolCallId), event.toolCallId),
          ...toolRefs(event.toolCallId),
          type: "content.delta",
          payload: { streamKind: toolStreamKind(itemType), delta: projection.text },
        });
      }
      if ((projection && projection.kind !== "none") || result) {
        events.push({
          ...withItemId(base(event.toolCallId), event.toolCallId),
          ...toolRefs(event.toolCallId),
          type: "item.updated",
          payload: {
            itemType,
            status: "inProgress",
            title: buildToolTitle(event.toolName, active?.args ?? event.args),
            data: buildToolData({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: active?.args ?? event.args,
              ...(projection ? { outputProjection: projection } : {}),
              ...(result ? { projectedResult: result } : {}),
            }),
          },
        });
      }
      return events;
    }
    case "tool_execution_end": {
      const active = state.activeTools.get(event.toolCallId);
      const itemType = active?.itemType ?? toToolItemType(event.toolName);
      const projection = active?.textProjector.project(readToolSnapshot(event.result));
      const projectedResult = projectToolMetadata(event.result);
      state.activeTools.delete(event.toolCallId);
      const events: Array<ProviderRuntimeEvent> = [];
      if (projection?.kind === "append" && projection.text.length > 0) {
        events.push({
          ...withItemId(base(event.toolCallId), event.toolCallId),
          ...toolRefs(event.toolCallId),
          type: "content.delta",
          payload: { streamKind: toolStreamKind(itemType), delta: projection.text },
        });
      }
      events.push({
        ...withItemId(base(event.toolCallId), event.toolCallId),
        ...toolRefs(event.toolCallId),
        type: "item.completed",
        payload: {
          itemType,
          status: event.isError ? "failed" : "completed",
          title: buildToolTitle(event.toolName, active?.args),
          ...(active?.textProjector.getMaterializedText()
            ? { detail: active.textProjector.getMaterializedText() }
            : {}),
          data: buildToolData({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: active?.args,
            ...(projection ? { outputProjection: projection } : {}),
            ...(projectedResult ? { projectedResult } : {}),
            result: event.result,
            isError: event.isError,
          }),
        },
      });
      return events;
    }
    case "bash_execution_update": {
      if (event.delta.length === 0) return [];
      const itemId = `pi-bash-${event.id ?? "session"}`;
      return [
        {
          ...withItemId(base(itemId), itemId),
          type: "content.delta",
          payload: { streamKind: "command_output", delta: event.delta },
        },
      ];
    }
    case "session_info_changed":
      return event.name?.trim()
        ? [
            {
              ...base(),
              type: "thread.metadata.updated",
              payload: { name: event.name.trim() },
            },
          ]
        : [];
    case "compaction_start": {
      const itemId = `pi-compaction-${state.turnId ?? "session"}`;
      return [
        {
          ...withItemId(base(itemId), itemId),
          type: "item.started",
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            title: "Context compaction",
            data: { reason: event.reason },
          },
        },
      ];
    }
    case "compaction_end": {
      const itemId = `pi-compaction-${state.turnId ?? "session"}`;
      return [
        {
          ...withItemId(base(itemId), itemId),
          type: "item.completed",
          payload: {
            itemType: "context_compaction",
            status: event.aborted || event.errorMessage ? "failed" : "completed",
            title: "Context compaction",
            ...(event.errorMessage ? { detail: event.errorMessage } : {}),
            data: {
              reason: event.reason,
              aborted: event.aborted,
              willRetry: event.willRetry,
              ...(event.result !== undefined ? { result: event.result } : {}),
            },
          },
        },
      ];
    }
    case "auto_retry_start":
      return [
        {
          ...base(),
          type: "runtime.warning",
          payload: {
            message: `Pi retrying request (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`,
            detail: event,
          },
        },
      ];
    case "auto_retry_end":
      return event.success
        ? []
        : [
            {
              ...base(),
              type: "runtime.error",
              payload: {
                message: event.finalError ?? `Pi retry attempt ${event.attempt} failed.`,
                class: classifyRuntimeError(
                  event.finalError ?? `Pi retry attempt ${event.attempt} failed.`,
                ),
                detail: event,
              },
            },
          ];
    case "summarization_retry_scheduled":
      return [
        {
          ...base(),
          type: "runtime.warning",
          payload: {
            message: `Pi scheduled summarization retry (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`,
            detail: event,
          },
        },
      ];
    case "summarization_retry_attempt_start":
      return [
        {
          ...base(),
          type: "runtime.warning",
          payload: {
            message: `Pi retrying ${event.source} summarization.`,
            detail: event,
          },
        },
      ];
    case "summarization_retry_finished":
      return [];
    case "queue_update":
      return [
        {
          ...base(),
          type: "input.queue.updated",
          payload: {
            steering: [...event.steering],
            followUp: [...event.followUp],
          },
        },
      ];
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "agent_settled":
    case "entry_appended":
    case "thinking_level_changed":
      return [];
    case "agent_end":
      return [];
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function historyItems(session: AgentSession): Array<unknown> {
  const items: Array<unknown> = [];
  for (const message of session.messages) {
    const role = getPiMessageRole(message);
    if (role === "user") {
      const text = getPiMessageText(message);
      if (text) items.push({ type: "user_message", text });
      continue;
    }
    if (role !== "assistant") continue;
    const content = recordFromUnknown(message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const record = recordFromUnknown(block);
      if (record?.type === "text" && typeof record.text === "string") {
        items.push({ type: "assistant_message", text: record.text });
      } else if (record?.type === "thinking" && typeof record.thinking === "string") {
        items.push({ type: "reasoning", text: record.thinking });
      }
    }
  }
  return items;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  settings: PiSettings,
  options: PiAdapterOptions,
) {
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PiSessionContext>();
  const effectContext = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(effectContext);
  const randomUUID = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Pi runtime identifier.",
          cause,
        }),
    ),
  );

  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
  const buildEventBase = Effect.fn("buildPiEventBase")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId;
    readonly raw?: unknown;
  }) {
    return {
      eventId: EventId.make(`pi-event-${yield* randomUUID}`),
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      threadId: input.threadId,
      createdAt: yield* nowIso,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.raw !== undefined
        ? { raw: { source: "pi.sdk.event" as const, payload: input.raw } }
        : {}),
    };
  });

  const makeProjectionEventBase = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | undefined;
    readonly raw: unknown;
  }): Omit<ProviderRuntimeEvent, "type" | "payload"> => ({
    eventId: EventId.make(`pi-event-${crypto.randomUUIDv4.pipe(Effect.runSync)}`),
    provider: PROVIDER,
    providerInstanceId: options.instanceId,
    threadId: input.threadId,
    createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    raw: { source: "pi.sdk.event", payload: input.raw },
  });

  const ensureContext = Effect.fn("ensurePiSessionContext")(function* (threadId: ThreadId) {
    const context = sessions.get(threadId);
    if (!context) {
      return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    }
    if (yield* Ref.get(context.stopped)) {
      return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
    }
    return context;
  });

  const updateSession = Effect.fn("updatePiProviderSession")(function* (
    context: PiSessionContext,
    patch: Partial<ProviderSession>,
    flags?: { readonly clearActiveTurnId?: boolean; readonly clearLastError?: boolean },
  ) {
    context.session = {
      ...context.session,
      ...patch,
      updatedAt: yield* nowIso,
      ...(flags?.clearActiveTurnId ? { activeTurnId: undefined } : {}),
      ...(flags?.clearLastError ? { lastError: undefined } : {}),
    };
  });

  const emitUsage = Effect.fn("emitPiTokenUsage")(function* (
    context: PiSessionContext,
    turnId?: TurnId,
  ) {
    const usage = normalizeTokenUsage(
      context.piSession.getSessionStats(),
      context.piSession.model?.contextWindow,
    );
    if (!usage) return;
    yield* emit({
      ...(yield* buildEventBase({
        threadId: context.session.threadId,
        ...(turnId ? { turnId } : {}),
      })),
      type: "thread.token-usage.updated",
      payload: { usage },
    });
  });

  const emitInputQueueUpdate = Effect.fn("emitPiInputQueueUpdate")(function* (
    context: PiSessionContext,
    turnId: TurnId | undefined,
  ) {
    yield* emit({
      ...(yield* buildEventBase({
        threadId: context.session.threadId,
        ...(turnId ? { turnId } : {}),
      })),
      type: "input.queue.updated",
      payload: {
        steering: [
          ...context.piSession.getSteeringMessages(),
          ...queuedDuringCompactionTexts(context, "steer"),
        ],
        followUp: [
          ...context.piSession.getFollowUpMessages(),
          ...queuedDuringCompactionTexts(context, "followUp"),
        ],
      },
    });
  });

  const stopContext = Effect.fn("stopPiContext")(function* (context: PiSessionContext) {
    if (yield* Ref.getAndSet(context.stopped, true)) return false;
    context.deferredUserMessages.splice(0);
    context.queuedDuringCompaction.splice(0);
    if (context.activePromptFiber)
      yield* Fiber.interrupt(context.activePromptFiber).pipe(Effect.ignore);
    if (context.compactionDrainFiber)
      yield* Fiber.interrupt(context.compactionDrainFiber).pipe(Effect.ignore);
    context.piSession.abortCompaction();
    yield* Effect.tryPromise({
      try: () => context.piSession.abort(),
      catch: () => undefined,
    }).pipe(Effect.ignore);
    context.unsubscribe();
    yield* Effect.sync(() => context.piSession.dispose()).pipe(Effect.ignore);
    yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
    return true;
  });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = Effect.fn(
    "PiAdapter.startSession",
  )(function* (input) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }
    if (input.providerInstanceId !== undefined && input.providerInstanceId !== options.instanceId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider instance '${options.instanceId}' but received '${input.providerInstanceId}'.`,
      });
    }
    const existing = sessions.get(input.threadId);
    if (existing) {
      yield* stopContext(existing);
      sessions.delete(input.threadId);
    }

    const cwd = input.cwd ?? serverConfig.cwd;
    const model = yield* Effect.tryPromise({
      try: () =>
        resolvePiModel(options.modelRuntime, input.modelSelection?.model, options.environment),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "model/resolve",
          detail: errorDetail(cause),
          cause,
        }),
    });
    if (!model) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: input.modelSelection?.model
          ? `Pi model '${input.modelSelection.model}' is unavailable or missing authentication.`
          : "No Pi model with configured authentication is available.",
      });
    }

    const sessionFile = extractResumeSessionFile(input.resumeCursor);
    const sessionManager = sessionFile
      ? yield* Effect.try({
          try: () => SessionManager.open(sessionFile, undefined, cwd),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: `Failed to open Pi session '${sessionFile}': ${errorDetail(cause)}`,
              cause,
            }),
        })
      : undefined;
    const scope = yield* Scope.make();
    const thinkingLevel = resolveThinkingLevel({ modelSelection: input.modelSelection });
    const created = yield* Effect.tryPromise({
      try: async () => {
        const created = await (options.createAgentSession ?? createAgentSession)({
          cwd,
          ...(settings.agentDir ? { agentDir: settings.agentDir } : {}),
          modelRuntime: options.modelRuntime,
          model,
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(sessionManager ? { sessionManager } : {}),
          ...(settings.tools.length > 0 ? { tools: [...settings.tools] } : {}),
          ...(settings.excludeTools.length > 0 ? { excludeTools: [...settings.excludeTools] } : {}),
          ...(settings.noTools ? { noTools: settings.noTools } : {}),
        });
        await created.session.bindExtensions({ mode: "rpc" });
        return created;
      },
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: errorDetail(cause),
          cause,
        }),
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));

    const createdAt = yield* nowIso;
    const resumeCursor = buildResumeCursor(created.session);
    const session: ProviderSession = {
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      status: "ready",
      runtimeMode: input.runtimeMode,
      cwd,
      model: `${model.provider}/${model.id}`,
      threadId: input.threadId,
      ...(resumeCursor ? { resumeCursor } : {}),
      createdAt,
      updatedAt: createdAt,
    };
    const contextRef: { current?: PiSessionContext } = {};
    const unsubscribe = created.session.subscribe((event) => {
      const context = contextRef.current;
      if (!context) return;
      const queueUpdateSuppressed = event.type === "queue_update" && context.suppressQueueUpdates;
      runFork(
        Effect.gen(function* () {
          if (event.type === "message_end") {
            const stopReason = getPiAssistantStopReason(event.message);
            if (stopReason === "error" || stopReason === "aborted") {
              context.activeTurnFailure = {
                state: stopReason === "aborted" ? "interrupted" : "failed",
                message:
                  getPiAssistantErrorMessage(event.message) ??
                  (stopReason === "aborted"
                    ? "Pi request was aborted."
                    : "Pi provider returned an error."),
              };
            }
          } else if (event.type === "agent_end" && !event.willRetry) {
            context.activeTurnFailure =
              findTerminalError(event.messages) ?? context.activeTurnFailure;
          }
          const isObservedDeferredUserMessage =
            event.type === "message_start" && getPiMessageRole(event.message) === "user"
              ? (() => {
                  const messageText = getPiMessageText(event.message);
                  return messageText && takeDeferredUserMessage(context, messageText)
                    ? messageText
                    : undefined;
                })()
              : undefined;
          const assistantItem = () => {
            if (context.activeAssistantItemId) return context.activeAssistantItemId;
            const itemId = `pi-assistant-${context.activeTurnId ?? "session"}-${context.nextAssistantMessageIndex++}`;
            context.activeAssistantItemId = itemId;
            return itemId;
          };
          const reasoningItem = () => {
            if (context.activeReasoningItemId) return context.activeReasoningItemId;
            const itemId = `pi-reasoning-${context.activeTurnId ?? "session"}`;
            context.activeReasoningItemId = itemId;
            return itemId;
          };
          const projected = projectPiSessionEvent(
            {
              threadId: input.threadId,
              turnId: context.activeTurnId,
              instanceId: options.instanceId,
              nextEventBase: ({ raw } = {}) =>
                makeProjectionEventBase({
                  threadId: input.threadId,
                  turnId: context.activeTurnId,
                  raw,
                }),
              activeTools: context.activeTools,
              nextAssistantItemId: assistantItem,
              nextReasoningItemId: reasoningItem,
            },
            event,
          );
          for (const runtimeEvent of projected) {
            if (runtimeEvent.type !== "input.queue.updated") yield* emit(runtimeEvent);
          }
          if (event.type === "queue_update" && !queueUpdateSuppressed) {
            yield* emitInputQueueUpdate(context, context.activeTurnId);
          }
          if (
            event.type === "compaction_end" &&
            context.activeCompactionTurnId === undefined &&
            context.queuedDuringCompaction.length > 0
          ) {
            const modelSlug = context.session.model;
            if (modelSlug) {
              context.compactionDrainFiber = yield* drainQueuedAfterCompaction(
                context,
                modelSlug,
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Pi automatic compaction queue drain failed", {
                    cause: Cause.pretty(cause),
                  }),
                ),
                Effect.asVoid,
                Effect.forkIn(context.scope),
              );
            }
          }
          if (isObservedDeferredUserMessage) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.threadId,
                ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
                raw: event,
              })),
              type: "user-message.observed",
              payload: { text: isObservedDeferredUserMessage },
            });
          }
          if (event.type === "message_end" && getPiMessageRole(event.message) === "assistant") {
            context.activeAssistantItemId = undefined;
            context.activeReasoningItemId = undefined;
          }
          if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
            appendTurnItem(context, context.activeTurnId, event);
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Pi event projection failed", { cause: Cause.pretty(cause) }),
          ),
        ),
      );
    });

    const context: PiSessionContext = {
      session,
      piSession: created.session,
      scope,
      unsubscribe,
      stopped: yield* Ref.make(false),
      turns: [],
      activeTools: new Map(),
      deferredUserMessages: [],
      queuedDuringCompaction: [],
      queueSemaphore: yield* Semaphore.make(1),
      suppressQueueUpdates: false,
      activeTurnId: undefined,
      activeCompactionTurnId: undefined,
      activePromptFiber: undefined,
      compactionDrainFiber: undefined,
      activeAssistantItemId: undefined,
      activeReasoningItemId: undefined,
      activeTurnFailure: undefined,
      nextAssistantMessageIndex: 0,
    };
    contextRef.current = context;
    sessions.set(input.threadId, context);

    yield* emit({
      ...(yield* buildEventBase({ threadId: input.threadId })),
      type: "session.started",
      payload: {
        message: "Pi SDK session started",
        ...(resumeCursor ? { resume: resumeCursor } : {}),
      },
    });
    yield* emit({
      ...(yield* buildEventBase({ threadId: input.threadId })),
      type: "thread.started",
      payload: { providerThreadId: created.session.sessionId },
    });
    yield* emitUsage(context);
    return session;
  });

  const drainQueuedAfterCompaction = Effect.fn("drainPiQueuedAfterCompaction")(function* (
    context: PiSessionContext,
    modelSlug: string,
  ) {
    const queued = context.queuedDuringCompaction.splice(0);
    if (queued.length === 0) return;

    const continuingActiveTurn =
      context.activeTurnId !== undefined && context.activeCompactionTurnId === undefined;
    const queuedTurnId = context.activeTurnId ?? TurnId.make(`pi-turn-${yield* randomUUID}`);
    if (!continuingActiveTurn) {
      context.activeTurnId = queuedTurnId;
      context.activeTurnFailure = undefined;
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
      context.nextAssistantMessageIndex = 0;
      yield* updateSession(
        context,
        { status: "running", activeTurnId: queuedTurnId, model: modelSlug },
        { clearLastError: true },
      );
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId: queuedTurnId })),
        type: "turn.started",
        payload: { model: modelSlug },
      });
    }
    yield* emitInputQueueUpdate(context, queuedTurnId);

    let firstPrompt: Promise<void> | undefined;
    const setupExit = yield* context.queueSemaphore
      .withPermit(
        Effect.tryPromise({
          try: async () => {
            if (continuingActiveTurn) {
              for (const message of queued) {
                message.source = "native";
                if (message.mode === "followUp") {
                  await context.piSession.followUp(message.text, message.images);
                } else {
                  await context.piSession.steer(message.text, message.images);
                }
              }
              return;
            }

            const [first, ...rest] = queued;
            if (!first) return;
            first.source = "native";
            firstPrompt = context.piSession.prompt(first.text, {
              ...(first.images.length > 0 ? { images: first.images } : {}),
              streamingBehavior: first.mode,
            });
            for (const message of rest) {
              message.source = "native";
              if (message.mode === "followUp") {
                await context.piSession.followUp(message.text, message.images);
              } else {
                await context.piSession.steer(message.text, message.images);
              }
            }
            return;
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "compact/drainQueuedInput",
              detail: errorDetail(cause),
              cause,
            }),
        }),
      )
      .pipe(Effect.exit);
    const runExit = Exit.isFailure(setupExit)
      ? setupExit
      : firstPrompt
        ? yield* Effect.tryPromise({
            try: () => firstPrompt!,
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "compact/drainQueuedInput",
                detail: errorDetail(cause),
                cause,
              }),
          }).pipe(Effect.exit)
        : Exit.void;

    if ((yield* Ref.get(context.stopped)) || context.activeTurnId !== queuedTurnId) return;
    if (continuingActiveTurn) {
      if (Exit.isFailure(runExit)) {
        const failed = context.deferredUserMessages.splice(0);
        context.piSession.clearQueue();
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: queuedTurnId,
            raw: runExit.cause,
          })),
          type: "runtime.error",
          payload: {
            message: Cause.pretty(runExit.cause),
            class: "provider_error",
            detail: {
              cause: runExit.cause,
              deferredMessages: failed.map((message) => message.text),
            },
          },
        });
      }
      context.compactionDrainFiber = undefined;
      return;
    }

    const failure = context.activeTurnFailure as PiTurnFailure | undefined;
    context.activeTurnId = undefined;
    context.activeCompactionTurnId = undefined;
    context.activePromptFiber = undefined;
    context.activeAssistantItemId = undefined;
    context.activeReasoningItemId = undefined;
    context.activeTurnFailure = undefined;
    if (Exit.isSuccess(runExit)) {
      yield* updateSession(
        context,
        failure
          ? {
              status: failure.state === "interrupted" ? "ready" : "error",
              lastError: failure.message,
            }
          : { status: "ready" },
        { clearActiveTurnId: true },
      );
      yield* emitUsage(context, queuedTurnId);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: queuedTurnId,
        })),
        type: "turn.completed",
        payload: failure
          ? { state: failure.state, errorMessage: failure.message }
          : { state: "completed" },
      });
      context.compactionDrainFiber = undefined;
      return;
    }

    const detail = Cause.pretty(runExit.cause);
    context.deferredUserMessages.splice(0);
    context.piSession.clearQueue();
    yield* updateSession(
      context,
      { status: "error", lastError: detail },
      { clearActiveTurnId: true },
    );
    yield* emit({
      ...(yield* buildEventBase({ threadId: context.session.threadId, turnId: queuedTurnId })),
      type: "turn.completed",
      payload: { state: "failed", errorMessage: detail },
    });
    yield* emit({
      ...(yield* buildEventBase({
        threadId: context.session.threadId,
        turnId: queuedTurnId,
        raw: runExit.cause,
      })),
      type: "runtime.error",
      payload: { message: detail, class: classifyRuntimeError(detail), detail: runExit.cause },
    });
    context.compactionDrainFiber = undefined;
  });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = Effect.fn(
    "PiAdapter.sendTurn",
  )(function* (input) {
    const context = yield* ensureContext(input.threadId);
    const selectedInstance = input.modelSelection?.instanceId;
    if (selectedInstance !== undefined && selectedInstance !== options.instanceId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Pi model selection is bound to instance '${selectedInstance}', expected '${options.instanceId}'.`,
      });
    }
    const model = yield* Effect.tryPromise({
      try: () =>
        resolvePiModel(
          options.modelRuntime,
          input.modelSelection?.model ?? context.session.model,
          options.environment,
        ),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "model/resolve",
          detail: errorDetail(cause),
          cause,
        }),
    });
    if (!model) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Pi model '${input.modelSelection?.model ?? context.session.model ?? ""}' is unavailable.`,
      });
    }

    const rawText = input.input?.trim();
    const text = rawText
      ? expandPiSkillMentions(rawText, context.piSession.resourceLoader.getSkills().skills)
      : rawText;
    const images = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) =>
        Effect.gen(function* () {
          if (attachment.type !== "image") return null;
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Invalid image attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "attachment/read",
                  detail: `Failed to read attachment file: ${cause.message}.`,
                  cause,
                }),
            ),
          );
          return {
            type: "image" as const,
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          };
        }),
      { concurrency: 1 },
    ).pipe(Effect.map((values) => values.filter((value) => value !== null)));
    if ((!text || text.length === 0) && images.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Pi turns require text input or at least one attachment.",
      });
    }

    const activeTurnId = context.activeTurnId;
    const midTurnInputMode = input.midTurnInputMode ?? "steer";
    if (text === "/reload" && images.length === 0) {
      if (activeTurnId || context.piSession.isStreaming || context.piSession.isCompacting) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Pi resources cannot be reloaded while a turn is active.",
        });
      }
      const turnId = TurnId.make(`pi-turn-${yield* randomUUID}`);
      const modelSlug = `${model.provider}/${model.id}`;
      context.activeTurnId = turnId;
      context.activeTurnFailure = undefined;
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
      context.nextAssistantMessageIndex = 0;
      yield* updateSession(
        context,
        { status: "running", activeTurnId: turnId, model: modelSlug },
        { clearLastError: true },
      );
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: { model: modelSlug },
      });
      yield* Effect.tryPromise({
        try: () => context.piSession.reload(),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "reload",
            detail: errorDetail(cause),
            cause,
          }),
      }).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            context.activeTurnId = undefined;
            yield* updateSession(
              context,
              { status: "error", lastError: error.detail },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId, raw: error })),
              type: "turn.completed",
              payload: { state: "failed", errorMessage: error.detail },
            });
          }),
        ),
      );
      context.activeTurnId = undefined;
      yield* updateSession(context, { status: "ready" }, { clearActiveTurnId: true });
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.completed",
        payload: { state: "completed" },
      });
      return { threadId: input.threadId, turnId };
    }
    if (
      (context.activeCompactionTurnId !== undefined || context.piSession.isCompacting) &&
      text !== undefined
    ) {
      const compactionTurnId = context.activeCompactionTurnId ?? activeTurnId;
      const queuedMessage: PiQueuedDuringCompactionInput = {
        mode: midTurnInputMode,
        text,
        images,
        source: "compaction",
      };
      context.queuedDuringCompaction.push(queuedMessage);
      context.deferredUserMessages.push(queuedMessage);
      yield* emitInputQueueUpdate(context, compactionTurnId);
      return {
        threadId: input.threadId,
        turnId: compactionTurnId ?? TurnId.make(`pi-turn-${yield* randomUUID}`),
      };
    }

    const compactMatch = text?.match(/^\/compact(?:\s+(.+))?$/);
    if (compactMatch) {
      const turnId = TurnId.make(`pi-turn-${yield* randomUUID}`);
      const customInstructions = compactMatch[1]?.trim();
      const modelSlug = `${model.provider}/${model.id}`;
      context.activeTurnId = turnId;
      context.activeCompactionTurnId = turnId;
      context.activeTurnFailure = undefined;
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
      context.nextAssistantMessageIndex = 0;
      yield* updateSession(
        context,
        { status: "running", activeTurnId: turnId, model: modelSlug },
        { clearLastError: true },
      );
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: { model: modelSlug },
      });

      const compactEffect = Effect.tryPromise({
        try: () => context.piSession.compact(customInstructions),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "compact",
            detail: errorDetail(cause),
            cause,
          }),
      }).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            if ((yield* Ref.get(context.stopped)) || context.activeCompactionTurnId !== turnId)
              return;
            context.activeTurnId = undefined;
            context.activeCompactionTurnId = undefined;
            context.activePromptFiber = undefined;
            context.activeTurnFailure = undefined;
            yield* updateSession(context, { status: "ready" }, { clearActiveTurnId: true });
            yield* emitUsage(context, turnId);
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: customInstructions
                  ? { instructions: customInstructions }
                  : { reason: "manual_compact_command" },
              },
            });
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.completed",
              payload: { state: "completed" },
            });
            yield* drainQueuedAfterCompaction(context, modelSlug);
          }),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if ((yield* Ref.get(context.stopped)) || context.activeCompactionTurnId !== turnId)
              return;
            context.activeTurnId = undefined;
            context.activeCompactionTurnId = undefined;
            context.activePromptFiber = undefined;
            yield* updateSession(
              context,
              { status: "error", lastError: error.detail },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId, raw: error })),
              type: "turn.completed",
              payload: { state: "failed", errorMessage: error.detail },
            });
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId, raw: error })),
              type: "runtime.error",
              payload: {
                message: error.detail,
                class: classifyRuntimeError(error.detail),
                detail: error,
              },
            });
            if (context.queuedDuringCompaction.length > 0) {
              yield* drainQueuedAfterCompaction(context, modelSlug);
            }
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logError("Pi compact fiber failed", { cause: Cause.pretty(cause) }),
        ),
      );
      context.activePromptFiber = yield* compactEffect.pipe(
        Effect.asVoid,
        Effect.forkIn(context.scope),
      );
      return { threadId: input.threadId, turnId };
    }

    if (activeTurnId) {
      const deferredMessage: PiDeferredUserMessage = {
        mode: midTurnInputMode,
        text: text ?? "",
        images,
        source: "native",
      };
      yield* context.queueSemaphore
        .withPermit(
          Effect.gen(function* () {
            context.deferredUserMessages.push(deferredMessage);
            yield* Effect.tryPromise({
              try: () =>
                context.piSession.prompt(text ?? "", {
                  ...(images.length > 0 ? { images } : {}),
                  streamingBehavior: midTurnInputMode,
                }),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: `prompt/${midTurnInputMode}`,
                  detail: errorDetail(cause),
                  cause,
                }),
            });
          }),
        )
        .pipe(
          Effect.tapError(() => Effect.sync(() => removeDeferredMessage(context, deferredMessage))),
        );
      return { threadId: input.threadId, turnId: activeTurnId };
    }

    const turnId = TurnId.make(`pi-turn-${yield* randomUUID}`);
    const modelSlug = `${model.provider}/${model.id}`;
    const thinkingLevel = resolveThinkingLevel(input);
    yield* Effect.tryPromise({
      try: async () => {
        await context.piSession.setModel(model);
        if (thinkingLevel) context.piSession.setThinkingLevel(thinkingLevel);
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "setModel",
          detail: errorDetail(cause),
          cause,
        }),
    });

    ensureTurn(context, turnId);
    context.activeTurnId = turnId;
    context.activeTurnFailure = undefined;
    context.activeAssistantItemId = undefined;
    context.activeReasoningItemId = undefined;
    context.nextAssistantMessageIndex = 0;
    yield* updateSession(
      context,
      { status: "running", activeTurnId: turnId, model: modelSlug },
      { clearLastError: true },
    );
    yield* emit({
      ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
      type: "turn.started",
      payload: { model: modelSlug, ...(thinkingLevel ? { effort: thinkingLevel } : {}) },
    });

    const promptEffect = Effect.tryPromise({
      try: () => context.piSession.prompt(text ?? "", images.length > 0 ? { images } : undefined),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: errorDetail(cause),
          cause,
        }),
    }).pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          if ((yield* Ref.get(context.stopped)) || context.activeTurnId !== turnId) return;
          const failure = context.activeTurnFailure;
          recordTurnLeaf(context, turnId);
          context.activeTurnId = undefined;
          context.activeCompactionTurnId = undefined;
          context.activePromptFiber = undefined;
          context.activeAssistantItemId = undefined;
          context.activeReasoningItemId = undefined;
          context.activeTurnFailure = undefined;
          yield* updateSession(
            context,
            failure
              ? {
                  status: failure.state === "interrupted" ? "ready" : "error",
                  lastError: failure.message,
                }
              : { status: "ready" },
            { clearActiveTurnId: true },
          );
          yield* emitUsage(context, turnId);
          yield* emit({
            ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
            type: "turn.completed",
            payload: failure
              ? { state: failure.state, errorMessage: failure.message }
              : { state: "completed" },
          });
        }),
      ),
      Effect.catch((error) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(context.stopped)) || context.activeTurnId !== turnId) return;
          context.activeTurnId = undefined;
          context.activeCompactionTurnId = undefined;
          context.activePromptFiber = undefined;
          yield* updateSession(
            context,
            { status: "error", lastError: error.detail },
            { clearActiveTurnId: true },
          );
          yield* emit({
            ...(yield* buildEventBase({ threadId: input.threadId, turnId, raw: error })),
            type: "turn.completed",
            payload: { state: "failed", errorMessage: error.detail },
          });
          yield* emit({
            ...(yield* buildEventBase({ threadId: input.threadId, turnId, raw: error })),
            type: "runtime.error",
            payload: {
              message: error.detail,
              class: classifyRuntimeError(error.detail),
              detail: error,
            },
          });
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Pi prompt fiber failed", { cause: Cause.pretty(cause) }),
      ),
    );
    context.activePromptFiber = yield* promptEffect.pipe(
      Effect.asVoid,
      Effect.forkIn(context.scope),
    );
    return {
      threadId: input.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const mutateInputQueue: NonNullable<
    ProviderAdapterShape<ProviderAdapterError>["mutateInputQueue"]
  > = Effect.fn("PiAdapter.mutateInputQueue")(function* (threadId, mutation) {
    const context = yield* ensureContext(threadId);
    yield* context.queueSemaphore.withPermit(
      Effect.gen(function* () {
        const nativeSteering = [...context.piSession.getSteeringMessages()];
        const nativeFollowUp = [...context.piSession.getFollowUpMessages()];
        const compactionSteering = context.queuedDuringCompaction.filter(
          (message) => message.mode === "steer",
        );
        const compactionFollowUp = context.queuedDuringCompaction.filter(
          (message) => message.mode === "followUp",
        );
        const retainedNative = {
          steer: [...nativeSteering],
          followUp: [...nativeFollowUp],
        };
        const retainedCompaction = {
          steer: [...compactionSteering],
          followUp: [...compactionFollowUp],
        };

        const removeMode = (mode: "steer" | "followUp") => {
          retainedNative[mode] = [];
          retainedCompaction[mode] = [];
        };
        if (mutation.type === "clear-all") {
          removeMode("steer");
          removeMode("followUp");
        } else if (mutation.type === "clear-mode") {
          removeMode(mutation.mode);
        } else {
          const native = retainedNative[mutation.mode];
          const compaction = retainedCompaction[mutation.mode];
          const actualText =
            mutation.index < native.length
              ? native[mutation.index]
              : compaction[mutation.index - native.length]?.text;
          if (actualText !== mutation.expectedText) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "mutateInputQueue",
              issue: `Queued ${mutation.mode} message at index ${mutation.index} no longer matches the requested item.`,
            });
          }
          if (mutation.index < native.length) native.splice(mutation.index, 1);
          else compaction.splice(mutation.index - native.length, 1);
        }

        const nativeDeferred = {
          steer: deferredMessagesByMode(context, "steer"),
          followUp: deferredMessagesByMode(context, "followUp"),
        };
        const retainedDeferred = new Set<PiDeferredUserMessage>();
        for (const mode of ["steer", "followUp"] as const) {
          const remainingTexts = [...retainedNative[mode]];
          for (const deferred of nativeDeferred[mode]) {
            const index = remainingTexts.indexOf(deferred.text);
            if (index !== -1) {
              retainedDeferred.add(deferred);
              remainingTexts.splice(index, 1);
            }
          }
          for (const deferred of retainedCompaction[mode]) retainedDeferred.add(deferred);
        }
        context.deferredUserMessages.splice(
          0,
          context.deferredUserMessages.length,
          ...context.deferredUserMessages.filter((message) => retainedDeferred.has(message)),
        );
        const retainedCompactionMessages = new Set<PiQueuedDuringCompactionInput>([
          ...retainedCompaction.steer,
          ...retainedCompaction.followUp,
        ]);
        context.queuedDuringCompaction.splice(
          0,
          context.queuedDuringCompaction.length,
          ...context.queuedDuringCompaction.filter((message) =>
            retainedCompactionMessages.has(message),
          ),
        );

        context.suppressQueueUpdates = true;
        try {
          context.piSession.clearQueue();
          for (const mode of ["steer", "followUp"] as const) {
            const deferred = [...nativeDeferred[mode]];
            for (const text of retainedNative[mode]) {
              const deferredIndex = deferred.findIndex((message) => message.text === text);
              const message =
                deferredIndex === -1 ? undefined : deferred.splice(deferredIndex, 1)[0];
              yield* Effect.tryPromise({
                try: () =>
                  mode === "followUp"
                    ? context.piSession.followUp(text, message?.images)
                    : context.piSession.steer(text, message?.images),
                catch: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "queue/rebuild",
                    detail: errorDetail(cause),
                    cause,
                  }),
              });
            }
          }
        } finally {
          context.suppressQueueUpdates = false;
        }
        yield* emitInputQueueUpdate(context, context.activeTurnId);
      }),
    );
  });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = Effect.fn(
    "PiAdapter.interruptTurn",
  )(function* (threadId, requestedTurnId) {
    const context = yield* ensureContext(threadId);
    const turnId = requestedTurnId ?? context.activeTurnId;
    context.activeTurnId = undefined;
    context.activeCompactionTurnId = undefined;
    context.deferredUserMessages.splice(0);
    context.queuedDuringCompaction.splice(0);
    if (context.compactionDrainFiber) {
      yield* Fiber.interrupt(context.compactionDrainFiber).pipe(Effect.ignore);
      context.compactionDrainFiber = undefined;
    }
    context.piSession.abortCompaction();
    yield* Effect.sync(() => context.piSession.clearQueue());
    yield* Effect.tryPromise({
      try: () => context.piSession.abort(),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "abort",
          detail: errorDetail(cause),
          cause,
        }),
    });
    context.activePromptFiber = undefined;
    context.activeAssistantItemId = undefined;
    context.activeReasoningItemId = undefined;
    context.activeTurnFailure = undefined;
    yield* updateSession(context, { status: "ready" }, { clearActiveTurnId: true });
    if (turnId) {
      yield* emit({
        ...(yield* buildEventBase({ threadId, turnId })),
        type: "turn.aborted",
        payload: { reason: "Interrupted by user." },
      });
      yield* emit({
        ...(yield* buildEventBase({ threadId, turnId })),
        type: "turn.completed",
        payload: { state: "interrupted" },
      });
    }
  });

  const unsupportedInteraction = (method: string, requestId: string) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Pi SDK does not expose interactive request '${requestId}' through this adapter.`,
      }),
    );

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = Effect.fn(
    "PiAdapter.stopSession",
  )(function* (threadId) {
    const context = yield* ensureContext(threadId);
    if (!(yield* stopContext(context))) return;
    sessions.delete(threadId);
    yield* emit({
      ...(yield* buildEventBase({ threadId })),
      type: "session.exited",
      payload: { reason: "Session stopped.", recoverable: false, exitKind: "graceful" },
    });
  });

  const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = Effect.fn(
    "PiAdapter.readThread",
  )(function* (threadId) {
    const context = yield* ensureContext(threadId);
    const historical = historyItems(context.piSession);
    return {
      threadId,
      turns:
        historical.length > 0
          ? [
              {
                id: TurnId.make(`pi-history-${context.piSession.sessionId}`),
                items: historical,
              },
              ...context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
            ]
          : context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
    } satisfies ProviderThreadSnapshot;
  });

  const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = Effect.fn(
    "PiAdapter.rollbackThread",
  )(function* (threadId, numTurns) {
    const context = yield* ensureContext(threadId);
    const nextLength = Math.max(0, context.turns.length - Math.max(0, numTurns));
    context.turns.splice(nextLength);
    const leafId = context.turns.at(-1)?.leafId;
    if (leafId) context.piSession.sessionManager.branch(leafId);
    else if (nextLength === 0) context.piSession.sessionManager.resetLeaf();
    context.piSession.agent.state.messages =
      context.piSession.sessionManager.buildSessionContext().messages;
    return yield* readThread(threadId);
  });

  const createDiscoveryServices = (cwd: string) =>
    (options.createAgentSessionServices ?? createAgentSessionServices)({
      cwd,
      ...(settings.agentDir ? { agentDir: settings.agentDir } : {}),
      modelRuntime: options.modelRuntime,
    });

  const listSkills: NonNullable<ProviderAdapterShape<ProviderAdapterError>["listSkills"]> =
    Effect.fn("PiAdapter.listSkills")(function* (input) {
      const active = input.threadId ? sessions.get(input.threadId) : undefined;
      const activeForCwd =
        active && (!input.cwd || !active.session.cwd || active.session.cwd === input.cwd)
          ? active
          : undefined;
      const result = yield* Effect.tryPromise({
        try: async () => {
          if (activeForCwd) {
            if (input.forceReload) await activeForCwd.piSession.reload();
            return activeForCwd.piSession.resourceLoader.getSkills();
          }
          const services = await createDiscoveryServices(input.cwd ?? serverConfig.cwd);
          return services.resourceLoader.getSkills();
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "skill/list",
            detail: errorDetail(cause),
            cause,
          }),
      });
      for (const diagnostic of result.diagnostics) {
        yield* Effect.logWarning("Pi skill discovery diagnostic", { diagnostic });
      }
      return {
        skills: result.skills.map(piSkillToServerProviderSkill),
        source: "pi.sdk",
        cached: false,
        diagnostics: piDiscoveryDiagnostics(result.diagnostics),
      };
    });

  const listCommands: NonNullable<ProviderAdapterShape<ProviderAdapterError>["listCommands"]> =
    Effect.fn("PiAdapter.listCommands")(function* (input) {
      const active = input.threadId ? sessions.get(input.threadId) : undefined;
      const activeForCwd =
        active && (!input.cwd || !active.session.cwd || active.session.cwd === input.cwd)
          ? active
          : undefined;
      return yield* Effect.tryPromise({
        try: async () => {
          if (activeForCwd && input.forceReload) await activeForCwd.piSession.reload();
          const resourceLoader = activeForCwd
            ? activeForCwd.piSession.resourceLoader
            : (await createDiscoveryServices(input.cwd ?? serverConfig.cwd)).resourceLoader;
          const promptResult = resourceLoader.getPrompts();
          const skillResult = resourceLoader.getSkills();
          const promptCommands = promptResult.prompts.map((prompt) => ({
            name: prompt.name,
            description: trimToUndefined(prompt.description) ?? "Prompt template",
            ...(trimToUndefined(prompt.argumentHint)
              ? { input: { hint: trimToUndefined(prompt.argumentHint)! } }
              : {}),
          }));
          const skillCommands = skillResult.skills.map((skill) => ({
            name: `skill:${skill.name}`,
            description: trimToUndefined(skill.description) ?? "Skill",
          }));
          const extensionCommands = activeForCwd
            ? activeForCwd.piSession.extensionRunner.getRegisteredCommands().map((command) => ({
                name: command.invocationName,
                description: trimToUndefined(command.description) ?? "Extension command",
              }))
            : [];
          return {
            commands: dedupePiCommands([
              PI_SLASH_COMMANDS,
              extensionCommands,
              promptCommands,
              skillCommands,
            ]),
            source: "pi.sdk",
            cached: false,
            diagnostics: piDiscoveryDiagnostics([
              ...promptResult.diagnostics,
              ...skillResult.diagnostics,
            ]),
          };
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "command/list",
            detail: errorDetail(cause),
            cause,
          }),
      });
    });

  const getComposerCapabilities: NonNullable<
    ProviderAdapterShape<ProviderAdapterError>["getComposerCapabilities"]
  > = () =>
    Effect.succeed({
      instanceId: options.instanceId,
      provider: PROVIDER,
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: true,
    });

  const stopAll = () =>
    Effect.gen(function* () {
      const contexts = [...sessions.values()];
      sessions.clear();
      yield* Effect.forEach(contexts, stopContext, { concurrency: "unbounded", discard: true });
      yield* Queue.shutdown(runtimeEvents);
    });
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", inputQueueMutation: true },
    startSession,
    sendTurn,
    interruptTurn,
    mutateInputQueue,
    respondToRequest: (_threadId, requestId) =>
      unsupportedInteraction("respondToRequest", requestId),
    respondToUserInput: (_threadId, requestId) =>
      unsupportedInteraction("respondToUserInput", requestId),
    stopSession,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread,
    rollbackThread,
    getComposerCapabilities,
    listSkills,
    listCommands,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEvents);
    },
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
