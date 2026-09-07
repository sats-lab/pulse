import { describe, expect, it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  PiSettings,
  ProjectId,
  ProviderInstanceId,
  SubagentId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionResult,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { ServerConfig } from "../../config.ts";
import { SubagentDriverError } from "../../orchestration/Services/SubagentDriver.ts";
import { makePiSubagentDriver } from "./PiSubagentDriver.ts";

const subagent = (id: string, prompt = "do the work") => ({
  id: SubagentId.make(id),
  title: "worker",
  prompt,
  origin: {
    projectId: ProjectId.make("project"),
    threadId: ThreadId.make("parent"),
    turnId: TurnId.make("turn"),
  },
  metadata: { providerInstanceId: ProviderInstanceId.make("pi"), model: "test/model" },
  status: "created" as const,
  delivery: "none" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const runtime = {
  getModel: () => ({ provider: "test", id: "model", contextWindow: 1000 }),
  getAuth: async () => ({ auth: { apiKey: "test" }, env: {} }),
  getAvailable: async () => [],
} as unknown as ModelRuntime;

const makeSession = (input: { prompt?: () => Promise<void>; abort?: () => Promise<void> } = {}) => {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const calls = {
    prompt: 0,
    abort: 0,
    dispose: 0,
    unsubscribe: 0,
    close: 0,
    tools: [] as ReadonlyArray<string>,
  };
  const session = {
    subscribe: (next: (event: AgentSessionEvent) => void) => {
      listener = next;
      return () => {
        calls.unsubscribe++;
        listener = undefined;
      };
    },
    prompt: async () => {
      calls.prompt++;
      await input.prompt?.();
    },
    abort: async () => {
      calls.abort++;
      await input.abort?.();
    },
    dispose: () => {
      calls.dispose++;
    },
    getLastAssistantText: () => "final text",
    bindExtensions: async () => undefined,
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "session",
      getLeafId: () => undefined,
    },
  } as unknown as AgentSession;
  return { session, calls, emit: (event: AgentSessionEvent) => listener?.(event) };
};

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3code-pi-subagent-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const make = (created: ReturnType<typeof makeSession>, target = subagent("one"), fail?: Error) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const serverConfig = yield* Effect.service(ServerConfig);
    const fileSystem = yield* Effect.service(FileSystem.FileSystem);
    const path = yield* Effect.service(Path.Path);
    return yield* makePiSubagentDriver({
      settings: PiSettings.make({
        enabled: true,
        agentDir: "",
        noTools: "",
        tools: [],
        excludeTools: [],
      }),
      modelRuntime: runtime,
      environment: {},
      instanceId: ProviderInstanceId.make("pi"),
      cwd: "/tmp",
      modelSlug: target.metadata.model,
      subagent: target,
      scope,
      fileSystem,
      path,
      serverConfig,
      createAgentSession: async (options) => {
        created.calls.tools = options?.tools ?? [];
        if (fail) throw fail;
        return {
          session: created.session,
          extensionsResult: { extensions: [], errors: [], runtime: {} },
        } as unknown as CreateAgentSessionResult;
      },
    });
  });

const observations = (
  driver: { observations: Stream.Stream<unknown, SubagentDriverError> },
  count: number,
) => Stream.runCollect(Stream.take(driver.observations, count));

describe("PiSubagentDriver", () => {
  effectIt.effect("uses hidden tools, does not prompt before start, and starts once", () =>
    Effect.gen(function* () {
      const created = makeSession();
      const driver = yield* make(created);
      expect(created.calls.prompt).toBe(0);
      yield* driver.start;
      yield* driver.start;
      expect(created.calls.tools).toEqual(["read", "bash", "edit", "write"]);
      expect(created.calls.prompt).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  effectIt.effect("streams started then completed final text", () =>
    Effect.gen(function* () {
      const created = makeSession();
      const driver = yield* make(created);
      yield* driver.start;
      created.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
      expect(yield* observations(driver, 2)).toMatchObject([
        { kind: "started" },
        { kind: "completed", text: "final text" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  effectIt.effect("ignores retryable agent_end events", () =>
    Effect.gen(function* () {
      const created = makeSession();
      const driver = yield* make(created);
      yield* driver.start;
      created.emit({ type: "agent_end", messages: [], willRetry: true } as AgentSessionEvent);
      created.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
      expect(yield* observations(driver, 2)).toMatchObject([
        { kind: "started" },
        { kind: "completed", text: "final text" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  effectIt.effect("terminates the observation stream after the terminal event", () =>
    Effect.gen(function* () {
      const created = makeSession();
      const driver = yield* make(created);
      yield* driver.start;
      created.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
      const result = yield* Stream.runCollect(driver.observations);
      expect(result).toHaveLength(2);
      expect(created.calls).toMatchObject({ dispose: 1, unsubscribe: 1 });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  effectIt.effect("maps an actual prompt rejection to failed", () =>
    Effect.gen(function* () {
      const driver = yield* make(
        makeSession({
          prompt: async () => {
            throw new Error("prompt failed");
          },
        }),
      );
      yield* driver.start;
      expect(yield* observations(driver, 2)).toMatchObject([
        { kind: "started" },
        { kind: "failed", text: "prompt failed" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  effectIt.effect("stops idempotently and closes resources once", () =>
    Effect.gen(function* () {
      const created = makeSession();
      const driver = yield* make(created);
      yield* driver.start;
      yield* driver.stop;
      yield* driver.stop;
      expect(created.calls).toMatchObject({ abort: 1, dispose: 1, unsubscribe: 1 });
      expect(yield* observations(driver, 2)).toMatchObject([
        { kind: "started" },
        { kind: "stopped" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  effectIt.effect("maps creation failures with the subagent ID", () =>
    Effect.gen(function* () {
      const id = subagent("creation-failure").id;
      const error = yield* Effect.flip(
        make(makeSession(), { ...subagent("creation-failure"), id }, new Error("cannot create")),
      );
      expect(error).toBeInstanceOf(SubagentDriverError);
      expect(error.subagentId).toBe(id);
      expect(error.message).toBe("cannot create");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  effectIt.effect("isolates multiple drivers", () =>
    Effect.gen(function* () {
      const first = makeSession();
      const second = makeSession();
      const a = yield* make(first, subagent("a"));
      const b = yield* make(second, subagent("b"));
      yield* a.start;
      yield* b.start;
      first.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
      expect(yield* observations(a, 2)).toMatchObject([
        { subagentId: SubagentId.make("a"), kind: "started" },
        { kind: "completed" },
      ]);
      expect(second.calls.prompt).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
