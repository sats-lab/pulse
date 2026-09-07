import { type PiSettings, type ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionResult,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makePreviewAutomationSnapshotToolView } from "../../mcp/PreviewAutomationSnapshotArtifacts.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { makePiPulseTools, PULSE_PI_TOOL_NAMES } from "./PiPulseTools.ts";
import {
  makePulseSubagentsTool,
  PULSE_SUBAGENTS_TOOL_NAME,
  type PulseSubagentsToolInput,
} from "./PulseSubagentsTool.ts";

export interface PiResumeCursor {
  readonly sessionFile: string;
  readonly sessionId: string;
}

export interface PiSessionFactoryInput {
  readonly settings: PiSettings;
  readonly modelRuntime: ModelRuntime;
  readonly randomUUID: Effect.Effect<string, Error, never>;
  readonly environment: Record<string, string>;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly modelSlug: string | undefined;
  readonly modelSelection?: {
    readonly model?: string;
    readonly instanceId?: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  };
  readonly resumeCursor?: unknown;
  readonly scope: Scope.Closeable;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly serverConfig: ServerConfig["Service"];
  readonly sessionPurpose?: "normal" | "hidden";
  readonly allowedToolNames?: ReadonlyArray<string>;
  readonly pulseSubagents?: () => Promise<Omit<PulseSubagentsToolInput, "run" | "randomUUID">>;
  readonly createAgentSession?: (
    options: Parameters<typeof createAgentSession>[0],
  ) => Promise<CreateAgentSessionResult>;
}

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

function parseModelSlug(slug: string | undefined): { provider: string; modelId: string } | null {
  if (!slug) return null;
  const separator = slug.indexOf("/");
  return separator > 0 && separator < slug.length - 1
    ? { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) }
    : null;
}

async function resolveModel(
  runtime: ModelRuntime,
  slug: string | undefined,
  environment: Record<string, string>,
): Promise<PiModel | undefined> {
  const parsed = parseModelSlug(slug);
  const model = parsed
    ? runtime.getModel(parsed.provider, parsed.modelId)
    : (await runtime.getAvailable())[0];
  if (!model) return undefined;
  return (await runtime.getAuth(model, { env: environment })) ? model : undefined;
}

function resolveThinkingLevel(input: {
  readonly modelSelection?: {
    readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  };
}): AgentSession["thinkingLevel"] | undefined {
  const value = input.modelSelection?.options?.find(
    (option) => option.id === "thinkingLevel",
  )?.value;
  return typeof value === "string" ? (value as AgentSession["thinkingLevel"]) : undefined;
}

function extractResumeSessionFile(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["sessionFile", "sessionFilePath", "nativeHandle", "path"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key] as string;
  }
  return undefined;
}

function buildResumeCursor(session: AgentSession): PiResumeCursor | undefined {
  const sessionFile = session.sessionManager.getSessionFile();
  return sessionFile
    ? { sessionFile, sessionId: session.sessionManager.getSessionId() }
    : undefined;
}

const errorDetail = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createPiSession = Effect.fn("createPiSession")(function* (
  input: PiSessionFactoryInput,
) {
  const { fileSystem, path, serverConfig } = input;
  const model = yield* Effect.tryPromise({
    try: () => resolveModel(input.modelRuntime, input.modelSlug, input.environment),
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: "pi",
        method: "model/resolve",
        detail: errorDetail(cause),
        cause,
      }),
  });
  if (!model)
    return yield* new ProviderAdapterValidationError({
      provider: "pi",
      operation: "startSession",
      issue: input.modelSlug
        ? `Pi model '${input.modelSlug}' is unavailable or missing authentication.`
        : "No Pi model with configured authentication is available.",
    });
  const sessionFile = extractResumeSessionFile(input.resumeCursor);
  const sessionManager = sessionFile
    ? yield* Effect.try({
        try: () => SessionManager.open(sessionFile, undefined, input.cwd),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: "pi",
            threadId: input.threadId,
            detail: `Failed to open Pi session '${sessionFile}': ${errorDetail(cause)}`,
            cause,
          }),
      })
    : undefined;
  const thinkingLevel = resolveThinkingLevel(input);
  const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
  const issuedAt = DateTime.nowUnsafe().epochMilliseconds;
  const pulseTools = mcpSession
    ? makePiPulseTools({
        environmentId: mcpSession.environmentId,
        threadId: input.threadId,
        providerInstanceId: input.instanceId,
        providerSessionId: mcpSession.providerSessionId,
        makeSnapshotToolView: (snapshot) =>
          Effect.runPromise(
            makePreviewAutomationSnapshotToolView({
              stateDir: serverConfig.stateDir,
              threadId: input.threadId,
              snapshot,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            ),
          ),
        issuedAt,
        expiresAt: Number.MAX_SAFE_INTEGER,
      })
    : [];
  const subagentTool =
    input.sessionPurpose !== "hidden" && input.pulseSubagents
      ? makePulseSubagentsTool(async () => ({
          ...(await input.pulseSubagents!()),
          run: <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect),
          randomUUID: input.randomUUID,
        }))
      : undefined;
  return yield* Effect.tryPromise({
    try: async () => {
      const created = await (input.createAgentSession ?? createAgentSession)({
        cwd: input.cwd,
        ...(input.settings.agentDir ? { agentDir: input.settings.agentDir } : {}),
        modelRuntime: input.modelRuntime,
        model,
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(sessionManager ? { sessionManager } : {}),
        ...(input.sessionPurpose === "hidden"
          ? { tools: [...(input.allowedToolNames ?? [])] }
          : {
              ...(input.allowedToolNames ? { allowedToolNames: [...input.allowedToolNames] } : {}),
              ...(input.settings.tools.length > 0 || pulseTools.length > 0 || subagentTool
                ? {
                    tools: [
                      ...new Set([
                        ...input.settings.tools,
                        ...(pulseTools.length > 0 ? PULSE_PI_TOOL_NAMES : []),
                        ...(subagentTool ? [PULSE_SUBAGENTS_TOOL_NAME] : []),
                      ]),
                    ],
                  }
                : {}),
              ...(input.settings.excludeTools.length > 0
                ? { excludeTools: [...input.settings.excludeTools] }
                : {}),
              ...(input.settings.noTools ? { noTools: input.settings.noTools } : {}),
              ...(pulseTools.length > 0 || subagentTool
                ? { customTools: [...pulseTools, ...(subagentTool ? [subagentTool] : [])] }
                : {}),
            }),
      });
      await created.session.bindExtensions({ mode: "rpc" });
      return {
        ...created,
        scope: input.scope,
        resumeCursor: buildResumeCursor(created.session),
        modelSlug: `${model.provider}/${model.id}`,
      };
    },
    catch: (cause) =>
      new ProviderAdapterProcessError({
        provider: "pi",
        threadId: input.threadId,
        detail: errorDetail(cause),
        cause,
      }),
  }).pipe(Effect.onError(() => Scope.close(input.scope, Exit.void).pipe(Effect.ignore)));
});
