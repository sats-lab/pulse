import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface SubagentResultDeliveryReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class SubagentResultDeliveryReactor extends Context.Service<
  SubagentResultDeliveryReactor,
  SubagentResultDeliveryReactorShape
>()("@sats-lab/pulse/orchestration/Services/SubagentResultDeliveryReactor") {}
