import {
  CommandId,
  SubagentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
  type TurnId,
  SubagentCreateCommand,
  SubagentStopRequestCommand,
  type PulseSubagent,
} from "@t3tools/contracts";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import { OrchestrationDomainEventSubscription } from "../../orchestration/Services/OrchestrationDomainEventSubscription.ts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSubagentRepository } from "../../persistence/Services/ProjectionSubagents.ts";

export const PULSE_SUBAGENTS_TOOL_NAME = "pulse_subagents";
const Parameters = Schema.Struct({
  operation: Schema.Literals(["start", "find", "status", "stop", "wait"]),
  id: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(
    Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  ),
  timeoutMs: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
});
type Parameters = typeof Parameters.Type;

export interface PulseSubagentsToolInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly modelSelection?: ModelSelection;
  readonly run: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;
  readonly engine: OrchestrationEngineService["Service"];
  readonly eventSubscription?: OrchestrationDomainEventSubscription["Service"];
  readonly repository: ProjectionSubagentRepository["Service"];
  readonly randomUUID: Effect.Effect<string, Error, never>;
}
const text = (value: unknown): AgentToolResult<Record<string, unknown>> => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  details: {},
});
const terminal = new Set(["completed", "failed", "stopped", "interrupted"]);
const now = () => DateTime.formatIso(DateTime.nowUnsafe());
const selectedModel = (input: PulseSubagentsToolInput, model?: string) =>
  model?.trim() || input.modelSelection?.model;

export function makePulseSubagentsTool(
  input: PulseSubagentsToolInput | (() => Promise<PulseSubagentsToolInput>),
): ToolDefinition {
  const resolveInput = typeof input === "function" ? input : async () => input;
  return {
    name: PULSE_SUBAGENTS_TOOL_NAME,
    label: "Pulse Subagents",
    description: "Start and monitor durable Pulse subagents for this thread.",
    parameters: Parameters as never,
    async execute(_callId, raw): Promise<AgentToolResult<Record<string, unknown>>> {
      const input = await resolveInput();
      const params = raw as Parameters;
      const list = () => input.repository.listByParentThreadId({ threadId: input.threadId });
      const resolve = async (): Promise<PulseSubagent | undefined> => {
        const entries = await input.run(list());
        if (params.id) return entries.find((entry) => entry.id === params.id);
        const title = params.title?.trim();
        const matches = title ? entries.filter((entry) => entry.title === title) : [];
        return matches.length === 1 ? matches[0] : undefined;
      };
      if (params.operation === "find") return text(await input.run(list()));
      if (params.operation === "start") {
        const title = params.title?.trim();
        const prompt = params.prompt?.trim();
        const model = selectedModel(input, params.model);
        if (!title || !prompt)
          return text({
            error: "invalid_input",
            message: "start requires nonempty title and prompt.",
          });
        if (!model)
          return text({
            error: "invalid_input",
            message: "start requires model or a selected parent model.",
          });
        const createdAt = now();
        const id = SubagentId.make(`pi-subagent-${await input.run(input.randomUUID)}`);
        const commandId = CommandId.make(`provider:pi:${await input.run(input.randomUUID)}`);
        const subagent: PulseSubagent = {
          id,
          title,
          prompt,
          origin: { projectId: input.projectId, threadId: input.threadId, turnId: input.turnId },
          metadata: { providerInstanceId: input.providerInstanceId, model },
          ...(params.thinking ? { thinking: params.thinking } : {}),
          status: "created",
          delivery: "none",
          createdAt,
        };
        await input.run(
          input.engine
            .dispatch({
              type: "subagent.create",
              commandId,
              subagentId: id,
              subagent,
              createdAt,
            } as never)
            .pipe(Effect.asVoid),
        );
        return text({ id, status: "created" });
      }
      const subagent = await resolve();
      if (!subagent)
        return text({
          error: "not_found",
          message: "Subagent was not found in the parent thread.",
        });
      if (params.operation === "status") return text(subagent);
      if (params.operation === "stop") {
        await input.run(
          input.engine
            .dispatch({
              type: "subagent.stop-request",
              commandId: CommandId.make(`provider:pi:${await input.run(input.randomUUID)}`),
              subagentId: subagent.id,
              createdAt: now(),
            })
            .pipe(Effect.asVoid),
        );
        return text({ id: subagent.id, status: "stop-requested" });
      }
      const timeout = Math.max(0, Math.min(params.timeoutMs ?? 30_000, 120_000));
      if (terminal.has(subagent.status)) return text(subagent);

      // Start the PubSub consumer before checking the projection. This is
      // important: Stream.fromPubSub is lazy, so subscribing after the read
      // can lose an event committed between the two operations.
      await input.run(
        Effect.scoped(
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<PulseSubagent>();
            const subscription = yield* input.eventSubscription
              ? input.eventSubscription.subscribe
              : Effect.die("event subscription unavailable");
            const subscriber = Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
              Stream.filter(
                (event) =>
                  "payload" in event &&
                  typeof event.payload === "object" &&
                  event.payload !== null &&
                  "subagentId" in event.payload &&
                  event.payload.subagentId === subagent.id,
              ),
              Stream.mapEffect(() => input.repository.getById({ subagentId: subagent.id })),
              Stream.filter((value) => Option.isSome(value)),
              Stream.map((value) => Option.getOrThrow(value)),
              Stream.filter((value) => terminal.has(value.status)),
              Stream.runHead,
              Effect.flatMap((value) =>
                value._tag === "Some" ? Deferred.succeed(deferred, value.value) : Effect.void,
              ),
              Effect.asVoid,
              Effect.orDie,
            );
            yield* Effect.forkScoped(subscriber);
            // The subscription was acquired before the durable re-read.

            const current = yield* input.repository.getById({ subagentId: subagent.id });
            if (Option.isSome(current) && terminal.has(current.value.status)) {
              return current.value;
            }
            const waited = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeout));
            return Option.isSome(waited) ? waited.value : undefined;
          }),
        ),
      );
      const final = await input.run(input.repository.getById({ subagentId: subagent.id }));
      if (Option.isSome(final) && terminal.has(final.value.status)) return text(final.value);
      return text({
        ...(Option.isSome(final) ? final.value : subagent),
        status: "waiting",
        timedOut: true,
      });
    },
  };
}
