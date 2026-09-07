import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  SubagentId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-pulse");
const threadId = ThreadId.make("thread-pulse");
const subagentId = SubagentId.make("subagent-pulse");
const subagent = {
  id: subagentId,
  origin: { projectId, threadId, turnId: TurnId.make("turn-pulse") },
  title: "Decider subagent",
  prompt: "Run the decider task",
  metadata: { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  effort: "high",
  status: "created" as const,
  delivery: "none" as const,
  createdAt: now,
};
const readModel = (threads: OrchestrationReadModel["threads"]): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [],
  threads,
  subagents: [],
  updatedAt: now,
});
const thread = (id: ThreadId, project: ProjectId) => ({
  id,
  projectId: project,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  interactionMode: "default" as const,
  runtimeMode: "full-access" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

it("decides valid create and rejects origin invariants", () =>
  Effect.gen(function* () {
    const command = {
      type: "subagent.create" as const,
      commandId: CommandId.make("cmd-pulse-create"),
      subagentId,
      subagent,
    };
    const event = yield* decideOrchestrationCommand({
      command,
      readModel: readModel([thread(threadId, projectId)]),
    });
    expect(event).toMatchObject({
      aggregateKind: "subagent",
      aggregateId: subagentId,
      type: "subagent.created",
      payload: { subagent },
    });
    expect(
      (yield* Effect.exit(
        decideOrchestrationCommand({
          command: { ...command, subagentId: SubagentId.make("other") },
          readModel: readModel([thread(threadId, projectId)]),
        }),
      ))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.exit(decideOrchestrationCommand({ command, readModel: readModel([]) })))._tag,
    ).toBe("Failure");
    expect(
      (yield* Effect.exit(
        decideOrchestrationCommand({
          command,
          readModel: readModel([thread(threadId, ProjectId.make("other-project"))]),
        }),
      ))._tag,
    ).toBe("Failure");
  }));
