import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { PulseSubagent, SubagentId } from "@t3tools/contracts";

export const SubagentObservation = Schema.Struct({
  subagentId: SubagentId,
  kind: Schema.Literals(["started", "progress", "waiting", "completed", "failed", "stopped"]),
  text: Schema.optional(Schema.String),
});
export type SubagentObservation = typeof SubagentObservation.Type;

export class SubagentDriverError extends Schema.TaggedErrorClass<SubagentDriverError>()(
  "SubagentDriverError",
  { message: Schema.String, subagentId: SubagentId },
) {}

/** Provider-neutral execution boundary. Implementations may attach Pi metadata. */
export interface SubagentDriver {
  readonly input: PulseSubagent;
  readonly observations: Stream.Stream<SubagentObservation, SubagentDriverError>;
  readonly start: Effect.Effect<void, SubagentDriverError>;
  readonly stop: Effect.Effect<void, SubagentDriverError>;
  /** Idempotently release all provider resources and end observations. */
  readonly dispose: Effect.Effect<void, SubagentDriverError>;
}

export interface LiveSubagentHandle {
  readonly subagent: PulseSubagent;
  readonly driver: SubagentDriver;
}
