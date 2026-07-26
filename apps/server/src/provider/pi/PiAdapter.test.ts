import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionServices,
  CreateAgentSessionResult,
  ModelRuntime,
  Skill,
} from "@earendil-works/pi-coding-agent";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makePiAdapter, projectPiSessionEvent } from "./PiAdapter.ts";

const THREAD_ID = ThreadId.make("thread-pi");
const TURN_ID = TurnId.make("turn-pi");
const INSTANCE_ID = ProviderInstanceId.make("pi-work");
const decodePiSettings = Schema.decodeSync(PiSettings);
const PI_SETTINGS = decodePiSettings({});
const PI_ADAPTER_TEST_LAYER = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-compaction-queue-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function piEvent(value: unknown): AgentSessionEvent {
  return value as AgentSessionEvent;
}

function makeState() {
  let index = 0;
  let assistantIndex = 0;
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    instanceId: INSTANCE_ID,
    nextEventBase: () => ({
      eventId: EventId.make(`event-${index++}`),
      provider: ProviderDriverKind.make("pi"),
      providerInstanceId: INSTANCE_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    activeTools: new Map(),
    nextAssistantItemId: () => `assistant-${assistantIndex++}`,
    nextReasoningItemId: () => "reasoning-1",
  } satisfies Parameters<typeof projectPiSessionEvent>[0];
}

function project(event: AgentSessionEvent): ReadonlyArray<ProviderRuntimeEvent> {
  return projectPiSessionEvent(makeState(), event);
}

function makeControllablePiSession(input?: { readonly skills?: ReadonlyArray<Skill> }) {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  let compactResolve: (() => void) | undefined;
  let promptResolve: (() => void) | undefined;
  let compacting = false;
  let streaming = false;
  let sessionStats = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    toolCalls: 0,
    contextUsage: { tokens: 0, contextWindow: 128_000, percent: 0 },
  };
  const steering: string[] = [];
  const followUp: string[] = [];
  const calls = {
    reload: 0,
    compact: [] as Array<string | undefined>,
    prompt: [] as Array<{ text: string; streamingBehavior?: "steer" | "followUp" }>,
    steer: [] as string[],
    followUp: [] as string[],
    steerImages: [] as Array<ReadonlyArray<{ readonly type: "image" }> | undefined>,
    followUpImages: [] as Array<ReadonlyArray<{ readonly type: "image" }> | undefined>,
  };
  const emit = (event: AgentSessionEvent) => listener?.(event);
  const resourceLoader = {
    getSkills: () => ({ skills: [...(input?.skills ?? [])], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    reload: async () => undefined,
  };
  const session = {
    get isCompacting() {
      return compacting;
    },
    get isStreaming() {
      return streaming;
    },
    get model() {
      return { provider: "test", id: "model", contextWindow: 128_000 };
    },
    sessionId: "pi-session-test",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "pi-session-test",
      getLeafId: () => undefined,
    },
    subscribe: (next: (event: AgentSessionEvent) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    bindExtensions: async () => undefined,
    resourceLoader,
    extensionRunner: { getRegisteredCommands: () => [] },
    reload: async () => {
      calls.reload += 1;
      await resourceLoader.reload();
    },
    getSessionStats: () => sessionStats,
    setModel: async () => undefined,
    setThinkingLevel: () => undefined,
    compact: async (instructions?: string) => {
      calls.compact.push(instructions);
      compacting = true;
      emit(piEvent({ type: "compaction_start", reason: "manual" }));
      await new Promise<void>((resolve) => {
        compactResolve = resolve;
      });
      emit(
        piEvent({
          type: "compaction_end",
          reason: "manual",
          result: { summary: "compacted" },
          aborted: false,
          willRetry: false,
        }),
      );
      compacting = false;
      return { summary: "compacted" };
    },
    prompt: async (
      text: string,
      options?: { readonly streamingBehavior?: "steer" | "followUp" },
    ) => {
      calls.prompt.push({ text, ...(options?.streamingBehavior ? options : {}) });
      if (streaming && options?.streamingBehavior) {
        const queue = options.streamingBehavior === "followUp" ? followUp : steering;
        queue.push(text);
        emit(piEvent({ type: "queue_update", steering: [...steering], followUp: [...followUp] }));
        return;
      }
      streaming = true;
      emit(piEvent({ type: "message_start", message: { role: "user", content: text } }));
      await new Promise<void>((resolve) => {
        promptResolve = resolve;
      });
      streaming = false;
    },
    steer: async (text: string, images?: ReadonlyArray<{ readonly type: "image" }>) => {
      calls.steer.push(text);
      calls.steerImages.push(images);
      steering.push(text);
      emit(piEvent({ type: "queue_update", steering: [...steering], followUp: [...followUp] }));
    },
    followUp: async (text: string, images?: ReadonlyArray<{ readonly type: "image" }>) => {
      calls.followUp.push(text);
      calls.followUpImages.push(images);
      followUp.push(text);
      emit(piEvent({ type: "queue_update", steering: [...steering], followUp: [...followUp] }));
    },
    getSteeringMessages: () => steering,
    getFollowUpMessages: () => followUp,
    clearQueue: () => {
      const snapshot = { steering: [...steering], followUp: [...followUp] };
      steering.splice(0);
      followUp.splice(0);
      emit(piEvent({ type: "queue_update", steering: [], followUp: [] }));
      return snapshot;
    },
    abortCompaction: () => {
      compacting = false;
      compactResolve?.();
    },
    abort: async () => {
      streaming = false;
      promptResolve?.();
    },
    dispose: () => undefined,
  } as unknown as AgentSession;
  return {
    session,
    calls,
    setUsage: (input: {
      readonly contextTokens: number;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
      readonly toolCalls?: number;
    }) => {
      const inputTokens = input.inputTokens ?? 0;
      const outputTokens = input.outputTokens ?? 0;
      const cacheRead = input.cacheReadTokens ?? 0;
      const cacheWrite = input.cacheWriteTokens ?? 0;
      sessionStats = {
        tokens: {
          input: inputTokens,
          output: outputTokens,
          cacheRead,
          cacheWrite,
          total: inputTokens + outputTokens + cacheRead + cacheWrite,
        },
        toolCalls: input.toolCalls ?? 0,
        contextUsage: {
          tokens: input.contextTokens,
          contextWindow: 128_000,
          percent: (input.contextTokens / 128_000) * 100,
        },
      };
    },
    emitAssistantUpdate: (delta = "x") =>
      emit(
        piEvent({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: delta }] },
          assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0 },
        }),
      ),
    emitAssistantEnd: (text = "done") =>
      emit(
        piEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            stopReason: "stop",
          },
        }),
      ),
    finishCompaction: () => compactResolve?.(),
    startAutoCompaction: () => {
      compacting = true;
      emit(piEvent({ type: "compaction_start", reason: "threshold" }));
    },
    finishAutoCompaction: () => {
      emit(
        piEvent({
          type: "compaction_end",
          reason: "threshold",
          result: { summary: "auto compacted" },
          aborted: false,
          willRetry: false,
        }),
      );
      compacting = false;
    },
    finishPrompt: () => promptResolve?.(),
  };
}

const TEST_MCP_SESSION = {
  environmentId: EnvironmentId.make("environment-pi-test"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-pi-test",
  providerInstanceId: INSTANCE_ID,
  endpoint: "http://127.0.0.1:3773/mcp",
  authorizationHeader: "Bearer pi-test",
} as const;

const withTestMcpSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => McpProviderSession.setMcpProviderSession(TEST_MCP_SESSION)),
    () => effect,
    () => Effect.sync(() => McpProviderSession.clearMcpProviderSession(THREAD_ID)),
  );

const waitUntil = Effect.fn("waitForPiAdapterTestCondition")(function* (predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Timed out waiting for Pi adapter test condition."));
});

describe("Pi adapter resource discovery", () => {
  effectIt.effect("discovers project skills and commands through Pi services", () => {
    const modelRuntime = {} as ModelRuntime;
    const skill = {
      name: "ui-review",
      description: "Review and improve user interface work",
      filePath: "/workspace/.pi/skills/ui-review/SKILL.md",
      baseDir: "/workspace/.pi/skills/ui-review",
      sourceInfo: { source: "project", scope: "project" },
      disableModelInvocation: false,
    } as Skill;
    const manualOnlySkill = {
      name: "grill-me",
      description: "Challenge the current approach",
      filePath: "/workspace/.pi/skills/grill-me/SKILL.md",
      baseDir: "/workspace/.pi/skills/grill-me",
      sourceInfo: { source: "project", scope: "project" },
      disableModelInvocation: true,
    } as Skill;
    const calls: string[] = [];
    const services = {
      cwd: "/workspace",
      agentDir: "/home/test/.pi/agent",
      modelRuntime,
      settingsManager: {},
      diagnostics: [],
      resourceLoader: {
        getSkills: () => ({
          skills: [skill, manualOnlySkill],
          diagnostics: [
            {
              type: "warning",
              message: "Ignored malformed project skill",
              path: "/workspace/.pi/skills/broken/SKILL.md",
            },
          ],
        }),
        getPrompts: () => ({
          prompts: [
            {
              name: "review",
              description: "Review current changes",
              argumentHint: "[path]",
              content: "Review $1",
              sourceInfo: { source: "project", scope: "project" },
              filePath: "/workspace/.pi/prompts/review.md",
            },
          ],
          diagnostics: [{ type: "error", message: "Could not parse legacy prompt" }],
        }),
        reload: async () => {
          calls.push("reload");
        },
      },
    } as unknown as AgentSessionServices;

    return Effect.gen(function* () {
      const adapter = yield* makePiAdapter(PI_SETTINGS, {
        instanceId: INSTANCE_ID,
        modelRuntime,
        environment: {},
        createAgentSessionServices: async (input) => {
          calls.push(input.cwd);
          return services;
        },
      });

      const skills = yield* adapter.listSkills!({
        instanceId: INSTANCE_ID,
        cwd: "/workspace",
      });
      const commands = yield* adapter.listCommands!({
        instanceId: INSTANCE_ID,
        cwd: "/workspace",
      });

      expect(calls).toEqual(["/workspace", "/workspace"]);
      expect(skills.skills).toEqual([
        {
          name: "ui-review",
          description: "Review and improve user interface work",
          path: "/workspace/.pi/skills/ui-review/SKILL.md",
          scope: "project",
          enabled: true,
          displayName: "Ui Review",
          shortDescription: "Review and improve user interface work",
        },
        {
          name: "grill-me",
          description: "Challenge the current approach",
          path: "/workspace/.pi/skills/grill-me/SKILL.md",
          scope: "project",
          enabled: true,
          displayName: "Grill Me",
          shortDescription: "Challenge the current approach",
        },
      ]);
      expect(commands.commands.map((command) => command.name)).toEqual([
        "reload",
        "compact",
        "review",
        "skill:ui-review",
        "skill:grill-me",
      ]);
      expect(commands.commands[2]).toMatchObject({ input: { hint: "[path]" } });
      expect(skills.diagnostics).toEqual([
        {
          severity: "warning",
          message: "Ignored malformed project skill",
          path: "/workspace/.pi/skills/broken/SKILL.md",
        },
      ]);
      expect(commands.diagnostics).toEqual([
        { severity: "error", message: "Could not parse legacy prompt" },
        {
          severity: "warning",
          message: "Ignored malformed project skill",
          path: "/workspace/.pi/skills/broken/SKILL.md",
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(PI_ADAPTER_TEST_LAYER));
  });

  effectIt.effect("includes active-session extension commands and keeps built-in priority", () => {
    const controlled = makeControllablePiSession();
    Object.assign(controlled.session.extensionRunner, {
      getRegisteredCommands: () => [
        { invocationName: "reload", description: "Shadow reload" },
        { invocationName: "deploy", description: "Deploy the project" },
      ],
    });
    Object.assign(controlled.session.resourceLoader, {
      getPrompts: () => ({
        prompts: [
          {
            name: "deploy",
            description: "Prompt deploy",
            content: "Deploy",
            sourceInfo: { source: "project", scope: "project" },
            filePath: "/workspace/.pi/prompts/deploy.md",
          },
        ],
        diagnostics: [],
      }),
    });
    const model = { provider: "test", id: "model", contextWindow: 128_000 };
    const modelRuntime = {
      getModel: () => model,
      getAvailable: async () => [model],
      getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
    } as unknown as ModelRuntime;

    return Effect.gen(function* () {
      const adapter = yield* makePiAdapter(PI_SETTINGS, {
        instanceId: INSTANCE_ID,
        modelRuntime,
        environment: {},
        createAgentSession: async (): Promise<CreateAgentSessionResult> => ({
          session: controlled.session,
          extensionsResult: {
            extensions: [],
            errors: [],
            runtime: {} as CreateAgentSessionResult["extensionsResult"]["runtime"],
          },
        }),
        createAgentSessionServices: async () =>
          ({
            resourceLoader: {
              getSkills: () => ({ skills: [], diagnostics: [] }),
              getPrompts: () => ({ prompts: [], diagnostics: [] }),
            },
          }) as unknown as AgentSessionServices,
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("pi"),
        providerInstanceId: INSTANCE_ID,
        threadId: THREAD_ID,
        runtimeMode: "full-access",
        modelSelection: { instanceId: INSTANCE_ID, model: "test/model" },
      });
      const result = yield* adapter.listCommands!({
        instanceId: INSTANCE_ID,
        threadId: THREAD_ID,
      });
      expect(result.commands).toMatchObject([
        { name: "reload" },
        { name: "compact" },
        { name: "deploy", description: "Deploy the project" },
      ]);
      const otherProject = yield* adapter.listCommands!({
        instanceId: INSTANCE_ID,
        threadId: THREAD_ID,
        cwd: "/workspace/other",
      });
      expect(otherProject.commands.map((command) => command.name)).toEqual(["reload", "compact"]);
    }).pipe(Effect.scoped, Effect.provide(PI_ADAPTER_TEST_LAYER));
  });
});

describe("Pi adapter Pulse tools", () => {
  effectIt.effect("registers Pulse tools and keeps them in an explicit Pi allowlist", () => {
    const controlled = makeControllablePiSession();
    const model = { provider: "test", id: "model", contextWindow: 128_000 };
    const modelRuntime = {
      getModel: () => model,
      getAvailable: async () => [model],
      getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
    } as unknown as ModelRuntime;
    let capturedOptions:
      | Parameters<typeof import("@earendil-works/pi-coding-agent").createAgentSession>[0]
      | undefined;
    const settings = decodePiSettings({ tools: ["read"] });

    return Effect.gen(function* () {
      const adapter = yield* makePiAdapter(settings, {
        instanceId: INSTANCE_ID,
        modelRuntime,
        environment: {},
        createAgentSession: async (options): Promise<CreateAgentSessionResult> => {
          capturedOptions = options;
          return {
            session: controlled.session,
            extensionsResult: {
              extensions: [],
              errors: [],
              runtime: {} as CreateAgentSessionResult["extensionsResult"]["runtime"],
            },
          };
        },
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("pi"),
        providerInstanceId: INSTANCE_ID,
        threadId: THREAD_ID,
        runtimeMode: "full-access",
        modelSelection: { instanceId: INSTANCE_ID, model: "test/model" },
      });

      expect(capturedOptions?.tools).toEqual(["read", "pulse_capability", "pulse_execute"]);
      expect(capturedOptions?.customTools?.map((tool) => tool.name)).toEqual([
        "pulse_capability",
        "pulse_execute",
      ]);
      expect(capturedOptions?.customTools?.[0]?.promptGuidelines).toContain(
        "Do not switch to standalone Playwright, Chrome, global browser skills, or agent-browser unless pulse_execute reports the Pulse preview is unsupported/unavailable or the user explicitly asks for another browser.",
      );
      const executeTool = capturedOptions?.customTools?.find(
        (tool) => tool.name === "pulse_execute",
      );
      const unavailable = yield* Effect.promise(() =>
        executeTool!.execute(
          "call-unavailable",
          { operation: "preview.status" },
          undefined,
          undefined,
          {} as never,
        ),
      );
      expect(unavailable.details).toMatchObject({ error: "preview_broker_unavailable" });
    }).pipe(withTestMcpSession, Effect.scoped, Effect.provide(PI_ADAPTER_TEST_LAYER));
  });
});

describe("Pi adapter reload", () => {
  effectIt.effect("reloads active Pi resources without sending a model prompt", () => {
    const controlled = makeControllablePiSession();
    const model = { provider: "test", id: "model", contextWindow: 128_000 };
    const modelRuntime = {
      getModel: () => model,
      getAvailable: async () => [model],
      getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
    } as unknown as ModelRuntime;

    return Effect.gen(function* () {
      const adapter = yield* makePiAdapter(PI_SETTINGS, {
        instanceId: INSTANCE_ID,
        modelRuntime,
        environment: {},
        createAgentSession: async (): Promise<CreateAgentSessionResult> => ({
          session: controlled.session,
          extensionsResult: {
            extensions: [],
            errors: [],
            runtime: {} as CreateAgentSessionResult["extensionsResult"]["runtime"],
          },
        }),
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("pi"),
        providerInstanceId: INSTANCE_ID,
        threadId: THREAD_ID,
        runtimeMode: "full-access",
        modelSelection: { instanceId: INSTANCE_ID, model: "test/model" },
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/reload" });
      expect(controlled.calls.reload).toBe(1);
      expect(controlled.calls.prompt).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(PI_ADAPTER_TEST_LAYER));
  });
});

describe("Pi adapter skill mentions", () => {
  effectIt.effect("expands discovered $skill mentions before prompting Pi", () => {
    const skill = {
      name: "ui-review",
      description: "Review UI",
      filePath: "/workspace/ui-review/SKILL.md",
      baseDir: "/workspace/ui-review",
      sourceInfo: { source: "project", scope: "project" },
      disableModelInvocation: false,
    } as Skill;
    const controlled = makeControllablePiSession({ skills: [skill] });
    const model = { provider: "test", id: "model", contextWindow: 128_000 };
    const modelRuntime = {
      getModel: () => model,
      getAvailable: async () => [model],
      getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
    } as unknown as ModelRuntime;

    return Effect.gen(function* () {
      const adapter = yield* makePiAdapter(PI_SETTINGS, {
        instanceId: INSTANCE_ID,
        modelRuntime,
        environment: {},
        createAgentSession: async (): Promise<CreateAgentSessionResult> => ({
          session: controlled.session,
          extensionsResult: {
            extensions: [],
            errors: [],
            runtime: {} as CreateAgentSessionResult["extensionsResult"]["runtime"],
          },
        }),
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("pi"),
        providerInstanceId: INSTANCE_ID,
        threadId: THREAD_ID,
        runtimeMode: "full-access",
        modelSelection: { instanceId: INSTANCE_ID, model: "test/model" },
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "Please $ui-review inspect this page",
      });
      yield* waitUntil(() => controlled.calls.prompt.length === 1);
      expect(controlled.calls.prompt[0]?.text).toBe("/skill:ui-review Please inspect this page");
      controlled.finishPrompt();
    }).pipe(Effect.scoped, Effect.provide(PI_ADAPTER_TEST_LAYER));
  });
});

describe("Pi adapter live context usage", () => {
  effectIt.effect(
    "streams bounded usage updates and flushes the final snapshot before turn completion",
    () => {
      const controlled = makeControllablePiSession();
      const model = { provider: "test", id: "model", contextWindow: 128_000 };
      const modelRuntime = {
        getModel: () => model,
        getAvailable: async () => [model],
        getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
      } as unknown as ModelRuntime;
      const events: ProviderRuntimeEvent[] = [];
      const threadId = ThreadId.make("thread-live-context-usage");

      return Effect.gen(function* () {
        const adapter = yield* makePiAdapter(PI_SETTINGS, {
          instanceId: INSTANCE_ID,
          modelRuntime,
          environment: {},
          createAgentSession: async (): Promise<CreateAgentSessionResult> => ({
            session: controlled.session,
            extensionsResult: {
              extensions: [],
              errors: [],
              runtime: {} as CreateAgentSessionResult["extensionsResult"]["runtime"],
            },
          }),
        });
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: INSTANCE_ID,
          threadId,
          runtimeMode: "full-access",
          modelSelection: { instanceId: INSTANCE_ID, model: "test/model" },
        });
        yield* waitUntil(() => events.some((event) => event.type === "thread.token-usage.updated"));
        events.splice(0);

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "Stream a response",
          attachments: [],
        });
        yield* waitUntil(() => controlled.calls.prompt.length === 1);

        controlled.setUsage({ contextTokens: 100, inputTokens: 80, outputTokens: 20 });
        controlled.emitAssistantUpdate("a");
        yield* waitUntil(() =>
          events.some(
            (event) =>
              event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 100,
          ),
        );

        controlled.setUsage({ contextTokens: 120, inputTokens: 90, outputTokens: 30 });
        controlled.emitAssistantUpdate("b");
        controlled.emitAssistantUpdate("c");
        controlled.emitAssistantUpdate("d");
        yield* Effect.yieldNow;
        expect(events.filter((event) => event.type === "thread.token-usage.updated")).toHaveLength(
          1,
        );

        yield* TestClock.adjust("1 second");
        yield* waitUntil(() =>
          events.some(
            (event) =>
              event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 120,
          ),
        );
        expect(
          events.filter(
            (event) =>
              event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 120,
          ),
        ).toHaveLength(1);

        controlled.emitAssistantUpdate("same snapshot");
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;
        expect(events.filter((event) => event.type === "thread.token-usage.updated")).toHaveLength(
          2,
        );

        controlled.setUsage({ contextTokens: 160, inputTokens: 110, outputTokens: 50 });
        controlled.emitAssistantUpdate("final delta");
        controlled.emitAssistantEnd();
        controlled.finishPrompt();
        yield* waitUntil(() => events.some((event) => event.type === "turn.completed"));

        const finalUsageIndex = events.findIndex(
          (event) =>
            event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 160,
        );
        const turnCompletedIndex = events.findIndex(
          (event) => event.type === "turn.completed" && event.turnId === turn.turnId,
        );
        expect(finalUsageIndex).toBeGreaterThan(-1);
        expect(turnCompletedIndex).toBeGreaterThan(finalUsageIndex);
        expect(
          events.filter(
            (event) =>
              event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 160,
          ),
        ).toHaveLength(1);
        yield* Fiber.interrupt(eventsFiber);
      }).pipe(Effect.scoped, Effect.provide(PI_ADAPTER_TEST_LAYER));
    },
  );

  effectIt.effect("cancels a pending usage update when the session stops", () => {
    const controlled = makeControllablePiSession();
    const model = { provider: "test", id: "model", contextWindow: 128_000 };
    const modelRuntime = {
      getModel: () => model,
      getAvailable: async () => [model],
      getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
    } as unknown as ModelRuntime;
    const events: ProviderRuntimeEvent[] = [];
    const threadId = ThreadId.make("thread-stopped-context-usage");

    return Effect.gen(function* () {
      const adapter = yield* makePiAdapter(PI_SETTINGS, {
        instanceId: INSTANCE_ID,
        modelRuntime,
        environment: {},
        createAgentSession: async (): Promise<CreateAgentSessionResult> => ({
          session: controlled.session,
          extensionsResult: {
            extensions: [],
            errors: [],
            runtime: {} as CreateAgentSessionResult["extensionsResult"]["runtime"],
          },
        }),
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("pi"),
        providerInstanceId: INSTANCE_ID,
        threadId,
        runtimeMode: "full-access",
        modelSelection: { instanceId: INSTANCE_ID, model: "test/model" },
      });
      yield* waitUntil(() => events.some((event) => event.type === "thread.token-usage.updated"));
      events.splice(0);
      yield* adapter.sendTurn({ threadId, input: "Stream a response", attachments: [] });
      yield* waitUntil(() => controlled.calls.prompt.length === 1);

      controlled.setUsage({ contextTokens: 100 });
      controlled.emitAssistantUpdate("first");
      yield* waitUntil(() =>
        events.some(
          (event) =>
            event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 100,
        ),
      );
      controlled.setUsage({ contextTokens: 120 });
      controlled.emitAssistantUpdate("pending");
      yield* adapter.stopSession(threadId);
      yield* waitUntil(() => events.some((event) => event.type === "session.exited"));

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      expect(
        events.some(
          (event) =>
            event.type === "thread.token-usage.updated" && event.payload.usage.usedTokens === 120,
        ),
      ).toBe(false);
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(Effect.scoped, Effect.provide(PI_ADAPTER_TEST_LAYER));
  });
});

describe("Pi adapter compaction queue", () => {
  effectIt.effect(
    "queues messages during automatic compaction and drains them into the active turn",
    () => {
      const controlled = makeControllablePiSession();
      const model = { provider: "test", id: "model", contextWindow: 128_000 };
      const modelRuntime = {
        getModel: () => model,
        getAvailable: async () => [model],
        getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
      } as unknown as ModelRuntime;
      const events: ProviderRuntimeEvent[] = [];
      const threadId = ThreadId.make("thread-auto-compaction-queue");

      return Effect.gen(function* () {
        const adapter = yield* makePiAdapter(PI_SETTINGS, {
          instanceId: INSTANCE_ID,
          modelRuntime,
          environment: {},
          createAgentSession: async (): Promise<CreateAgentSessionResult> => ({
            session: controlled.session,
            extensionsResult: {
              extensions: [],
              errors: [],
              runtime: {} as CreateAgentSessionResult["extensionsResult"]["runtime"],
            },
          }),
        });
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: INSTANCE_ID,
          threadId,
          runtimeMode: "full-access",
          modelSelection: { instanceId: INSTANCE_ID, model: "test/model" },
        });
        const activeTurn = yield* adapter.sendTurn({
          threadId,
          input: "Implement the feature",
          attachments: [],
        });
        yield* waitUntil(() => controlled.calls.prompt.length === 1);

        controlled.startAutoCompaction();
        const queuedTurn = yield* adapter.sendTurn({
          threadId,
          input: "Run focused tests afterward",
          attachments: [],
          midTurnInputMode: "followUp",
        });
        expect(queuedTurn.turnId).toBe(activeTurn.turnId);
        expect(controlled.calls.prompt).toHaveLength(1);

        controlled.finishAutoCompaction();
        yield* waitUntil(() => controlled.calls.followUp.length === 1);
        expect(controlled.calls.followUp).toEqual(["Run focused tests afterward"]);
        expect(controlled.calls.steer).toHaveLength(0);
        expect(controlled.calls.prompt).toHaveLength(1);
        expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);

        controlled.finishPrompt();
        yield* waitUntil(() => events.some((event) => event.type === "turn.completed"));
        yield* Fiber.interrupt(eventsFiber);
      }).pipe(Effect.scoped, Effect.provide(PI_ADAPTER_TEST_LAYER));
    },
  );

  effectIt.effect(
    "removes individual native and compaction queue entries and clears sections",
    () => {
      const controlled = makeControllablePiSession();
      const model = { provider: "test", id: "model", contextWindow: 128_000 };
      const modelRuntime = {
        getModel: () => model,
        getAvailable: async () => [model],
        getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
      } as unknown as ModelRuntime;
      const events: ProviderRuntimeEvent[] = [];
      const threadId = ThreadId.make("thread-queue-mutations");

      return Effect.gen(function* () {
        const adapter = yield* makePiAdapter(PI_SETTINGS, {
          instanceId: INSTANCE_ID,
          modelRuntime,
          environment: {},
          createAgentSession: async (): Promise<CreateAgentSessionResult> => ({
            session: controlled.session,
            extensionsResult: {
              extensions: [],
              errors: [],
              runtime: {} as CreateAgentSessionResult["extensionsResult"]["runtime"],
            },
          }),
        });
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: INSTANCE_ID,
          threadId,
          runtimeMode: "full-access",
          modelSelection: { instanceId: INSTANCE_ID, model: "test/model" },
        });
        yield* adapter.sendTurn({ threadId, input: "Implement", attachments: [] });
        yield* waitUntil(() => controlled.calls.prompt.length === 1);
        yield* adapter.sendTurn({
          threadId,
          input: "steer one",
          attachments: [],
          midTurnInputMode: "steer",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "steer two",
          attachments: [],
          midTurnInputMode: "steer",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "follow later",
          attachments: [],
          midTurnInputMode: "followUp",
        });

        yield* adapter.mutateInputQueue?.(threadId, {
          type: "remove",
          mode: "steer",
          index: 0,
          expectedText: "steer one",
        });
        yield* waitUntil(
          () =>
            events.findLast((event) => event.type === "input.queue.updated")?.payload !== undefined,
        );
        expect(events.findLast((event) => event.type === "input.queue.updated")).toMatchObject({
          payload: { steering: ["steer two"], followUp: ["follow later"] },
        });

        controlled.startAutoCompaction();
        yield* adapter.sendTurn({
          threadId,
          input: "compaction steer",
          attachments: [],
          midTurnInputMode: "steer",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "compaction follow",
          attachments: [],
          midTurnInputMode: "followUp",
        });
        yield* adapter.mutateInputQueue?.(threadId, {
          type: "remove",
          mode: "steer",
          index: 1,
          expectedText: "compaction steer",
        });
        yield* waitUntil(() => {
          const event = events.findLast((candidate) => candidate.type === "input.queue.updated");
          return (
            event?.type === "input.queue.updated" &&
            event.payload.followUp.includes("compaction follow")
          );
        });
        expect(events.findLast((event) => event.type === "input.queue.updated")).toMatchObject({
          payload: { steering: ["steer two"], followUp: ["follow later", "compaction follow"] },
        });

        yield* adapter.mutateInputQueue?.(threadId, {
          type: "clear-mode",
          mode: "followUp",
        });
        yield* waitUntil(() => {
          const event = events.findLast((candidate) => candidate.type === "input.queue.updated");
          return event?.type === "input.queue.updated" && event.payload.followUp.length === 0;
        });
        expect(events.findLast((event) => event.type === "input.queue.updated")).toMatchObject({
          payload: { steering: ["steer two"], followUp: [] },
        });

        yield* adapter.mutateInputQueue?.(threadId, { type: "clear-all" });
        yield* waitUntil(() => {
          const event = events.findLast((candidate) => candidate.type === "input.queue.updated");
          return (
            event?.type === "input.queue.updated" &&
            event.payload.steering.length === 0 &&
            event.payload.followUp.length === 0
          );
        });
        expect(events.findLast((event) => event.type === "input.queue.updated")).toMatchObject({
          payload: { steering: [], followUp: [] },
        });
        controlled.finishAutoCompaction();
        controlled.finishPrompt();
        yield* Fiber.interrupt(eventsFiber);
      }).pipe(Effect.scoped, Effect.provide(PI_ADAPTER_TEST_LAYER));
    },
  );

  effectIt.effect("clears messages queued during compaction when interrupted", () => {
    const controlled = makeControllablePiSession();
    const model = { provider: "test", id: "model", contextWindow: 128_000 };
    const modelRuntime = {
      getModel: () => model,
      getAvailable: async () => [model],
      getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
    } as unknown as ModelRuntime;
    const events: ProviderRuntimeEvent[] = [];
    const threadId = ThreadId.make("thread-interrupted-compaction-queue");

    return Effect.gen(function* () {
      const adapter = yield* makePiAdapter(PI_SETTINGS, {
        instanceId: INSTANCE_ID,
        modelRuntime,
        environment: {},
        createAgentSession: async (): Promise<CreateAgentSessionResult> => ({
          session: controlled.session,
          extensionsResult: {
            extensions: [],
            errors: [],
            runtime: {} as CreateAgentSessionResult["extensionsResult"]["runtime"],
          },
        }),
      });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("pi"),
        providerInstanceId: INSTANCE_ID,
        threadId,
        runtimeMode: "full-access",
        modelSelection: { instanceId: INSTANCE_ID, model: "test/model" },
      });
      const compactTurn = yield* adapter.sendTurn({
        threadId,
        input: "/compact",
        attachments: [],
      });
      yield* waitUntil(() => controlled.calls.compact.length === 1);
      yield* adapter.sendTurn({
        threadId,
        input: "Do not lose this unless interrupted",
        attachments: [],
      });

      yield* adapter.interruptTurn(threadId, compactTurn.turnId);
      yield* waitUntil(() => events.some((event) => event.type === "turn.aborted"));
      expect(controlled.calls.prompt).toHaveLength(0);
      expect(controlled.calls.steer).toHaveLength(0);
      expect(controlled.calls.followUp).toHaveLength(0);
      const sessions = yield* adapter.listSessions();
      expect(sessions[0]).toMatchObject({ status: "ready", activeTurnId: undefined });
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(Effect.scoped, Effect.provide(PI_ADAPTER_TEST_LAYER));
  });

  effectIt.effect(
    "queues messages during manual compaction and drains them through public session APIs",
    () => {
      const controlled = makeControllablePiSession();
      const model = { provider: "test", id: "model", contextWindow: 128_000 };
      const modelRuntime = {
        getModel: () => model,
        getAvailable: async () => [model],
        getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
      } as unknown as ModelRuntime;
      const events: ProviderRuntimeEvent[] = [];
      const threadId = ThreadId.make("thread-compaction-queue");

      return Effect.gen(function* () {
        const adapter = yield* makePiAdapter(PI_SETTINGS, {
          instanceId: INSTANCE_ID,
          modelRuntime,
          environment: {},
          createAgentSession: async (): Promise<CreateAgentSessionResult> => ({
            session: controlled.session,
            extensionsResult: {
              extensions: [],
              errors: [],
              runtime: {} as CreateAgentSessionResult["extensionsResult"]["runtime"],
            },
          }),
        });
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: INSTANCE_ID,
          threadId,
          runtimeMode: "full-access",
          modelSelection: { instanceId: INSTANCE_ID, model: "test/model" },
        });

        const compactTurn = yield* adapter.sendTurn({
          threadId,
          input: "/compact preserve decisions",
          attachments: [],
        });
        yield* waitUntil(() => controlled.calls.compact.length === 1);
        const firstQueued = yield* adapter.sendTurn({
          threadId,
          input: "Prefer the smaller patch",
          attachments: [],
        });
        const secondQueued = yield* adapter.sendTurn({
          threadId,
          input: "Then run focused tests",
          attachments: [],
        });

        expect(firstQueued.turnId).toBe(compactTurn.turnId);
        expect(secondQueued.turnId).toBe(compactTurn.turnId);
        expect(controlled.calls.prompt).toHaveLength(0);
        yield* waitUntil(() => events.some((event) => event.type === "input.queue.updated"));
        expect(events.findLast((event) => event.type === "input.queue.updated")).toMatchObject({
          payload: {
            steering: ["Prefer the smaller patch", "Then run focused tests"],
            followUp: [],
          },
        });

        controlled.finishCompaction();
        yield* waitUntil(
          () => controlled.calls.prompt.length === 1 && controlled.calls.steer.length === 1,
        );
        expect(controlled.calls.compact).toEqual(["preserve decisions"]);
        expect(controlled.calls.prompt[0]?.text).toBe("Prefer the smaller patch");
        expect(controlled.calls.steer).toEqual(["Then run focused tests"]);

        controlled.finishPrompt();
        yield* waitUntil(() => events.some((event) => event.type === "user-message.observed"));
        yield* Fiber.interrupt(eventsFiber);
      }).pipe(Effect.scoped, Effect.provide(PI_ADAPTER_TEST_LAYER));
    },
  );
});

describe("projectPiSessionEvent", () => {
  it("normalizes assistant text deltas", () => {
    expect(
      project(
        piEvent({
          type: "message_update",
          message: { role: "assistant", content: [] },
          assistantMessageEvent: { type: "text_delta", delta: "hello", contentIndex: 0 },
        }),
      ),
    ).toMatchObject([
      {
        type: "content.delta",
        itemId: "assistant-0",
        payload: { streamKind: "assistant_text", delta: "hello", contentIndex: 0 },
      },
    ]);
  });

  it("projects cumulative tool snapshots into compact bounded updates", () => {
    const state = makeState();

    projectPiSessionEvent(
      state,
      piEvent({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "printf hello" },
      }),
    );
    const first = projectPiSessionEvent(
      state,
      piEvent({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "printf hello" },
        partialResult: {
          content: [{ type: "text", text: "hello" }],
          details: { truncation: undefined },
        },
      }),
    );
    const second = projectPiSessionEvent(
      state,
      piEvent({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "printf hello" },
        partialResult: {
          content: [{ type: "text", text: "hello world" }],
          details: { truncation: undefined },
        },
      }),
    );

    expect(first.find((event) => event.type === "content.delta")).toMatchObject({
      payload: { delta: "hello" },
    });
    expect(second.find((event) => event.type === "content.delta")).toMatchObject({
      payload: { delta: " world" },
    });
    const updated = second.find((event) => event.type === "item.updated");
    expect(updated).toMatchObject({
      payload: {
        data: {
          toolCallId: "tool-1",
          toolName: "bash",
          outputProjection: { kind: "append", text: " world" },
        },
      },
    });
    expect(JSON.stringify(updated)).not.toContain("hello world");
  });

  it("handles rolling truncated tails without duplicating output", () => {
    const state = makeState();
    projectPiSessionEvent(
      state,
      piEvent({
        type: "tool_execution_start",
        toolCallId: "tool-rolling",
        toolName: "bash",
        args: { command: "long-running" },
      }),
    );
    const first = projectPiSessionEvent(
      state,
      piEvent({
        type: "tool_execution_update",
        toolCallId: "tool-rolling",
        toolName: "bash",
        args: { command: "long-running" },
        partialResult: {
          content: [{ type: "text", text: "line-1\nline-2\nline-3\n" }],
          details: { truncation: { truncated: true, totalBytes: 21 } },
        },
      }),
    );
    const second = projectPiSessionEvent(
      state,
      piEvent({
        type: "tool_execution_update",
        toolCallId: "tool-rolling",
        toolName: "bash",
        args: { command: "long-running" },
        partialResult: {
          content: [{ type: "text", text: "line-2\nline-3\nline-4\n" }],
          details: { truncation: { truncated: true, totalBytes: 28 } },
        },
      }),
    );

    expect(first.find((event) => event.type === "content.delta")).toMatchObject({
      payload: { delta: "line-1\nline-2\nline-3\n" },
    });
    expect(second.find((event) => event.type === "content.delta")).toMatchObject({
      payload: { delta: "line-4\n" },
    });
  });

  it("projects Pi queue snapshots without creating user message events", () => {
    expect(
      project(
        piEvent({
          type: "queue_update",
          steering: ["Prefer the smaller patch"],
          followUp: ["Then run the focused test"],
        }),
      ),
    ).toMatchObject([
      {
        type: "input.queue.updated",
        payload: {
          steering: ["Prefer the smaller patch"],
          followUp: ["Then run the focused test"],
        },
      },
    ]);
  });

  it("handles Pi 0.82 bash and summarization retry events", () => {
    expect(
      project(piEvent({ type: "bash_execution_update", id: "shell-1", delta: "done\n" })),
    ).toMatchObject([
      {
        type: "content.delta",
        itemId: "pi-bash-shell-1",
        payload: { streamKind: "command_output", delta: "done\n" },
      },
    ]);
    expect(
      project(
        piEvent({
          type: "summarization_retry_scheduled",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 250,
          errorMessage: "temporary failure",
        }),
      ),
    ).toMatchObject([
      {
        type: "runtime.warning",
        payload: { message: expect.stringContaining("temporary failure") },
      },
    ]);
  });

  it("characterizes every Pi 0.82 AgentSession event discriminant", () => {
    const events = [
      { type: "agent_start" },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
      { type: "turn_start" },
      { type: "turn_end", message: { role: "assistant" }, toolResults: [] },
      { type: "message_start", message: { role: "user", content: "hello" } },
      { type: "message_end", message: { role: "user", content: "hello" } },
      { type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: {} },
      {
        type: "tool_execution_update",
        toolCallId: "tool",
        toolName: "read",
        args: {},
        partialResult: { content: [] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tool",
        toolName: "read",
        result: { content: [] },
        isError: false,
      },
      { type: "queue_update", steering: [], followUp: [] },
      { type: "entry_appended", entry: {} },
      { type: "session_info_changed", name: undefined },
      { type: "thinking_level_changed", level: "medium" },
      { type: "compaction_start", reason: "manual" },
      {
        type: "compaction_end",
        reason: "manual",
        result: undefined,
        aborted: false,
        willRetry: false,
      },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "x" },
      { type: "auto_retry_end", success: true, attempt: 1 },
      {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1,
        errorMessage: "x",
      },
      { type: "summarization_retry_attempt_start", source: "branchSummary" },
      { type: "summarization_retry_attempt_start", source: "compaction", reason: "threshold" },
      { type: "summarization_retry_finished" },
      { type: "bash_execution_update", id: "bash", delta: "x" },
    ].map(piEvent);

    const state = makeState();
    for (const event of events) {
      expect(() => projectPiSessionEvent(state, event)).not.toThrow();
    }
  });
});
