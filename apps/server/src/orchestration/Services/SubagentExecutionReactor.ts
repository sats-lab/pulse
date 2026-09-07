import type {
  OrchestrationEvent,
  OrchestrationCommand,
  PulseSubagent,
  SubagentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { SubagentDriver } from "./SubagentDriver.ts";

export interface SubagentExecutionReactorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

/** Owns the provider-neutral subagent execution boundary. */
export class SubagentExecutionReactor extends Context.Service<
  SubagentExecutionReactor,
  SubagentExecutionReactorShape
>()("@sats-lab/pulse/orchestration/Services/SubagentExecutionReactor") {}

export type SubagentExecutionEvent = Extract<
  OrchestrationEvent,
  { type: "subagent.created" | "subagent.stop-requested" }
>;

export type SubagentExecutionCommand = Extract<
  OrchestrationCommand,
  { type: `subagent.${string}` }
>;
export type SubagentExecutionSubagentId = SubagentId;
