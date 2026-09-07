import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

export class OrchestrationDomainEventBus extends Context.Service<
  OrchestrationDomainEventBus,
  PubSub.PubSub<OrchestrationEvent>
>()(
  "@sats-lab/pulse/orchestration/Services/OrchestrationDomainEventSubscription/OrchestrationDomainEventBus",
) {}

export interface OrchestrationDomainEventSubscriptionShape {
  readonly subscribe: Effect.Effect<PubSub.Subscription<OrchestrationEvent>, never, Scope.Scope>;
}

export class OrchestrationDomainEventSubscription extends Context.Service<
  OrchestrationDomainEventSubscription,
  OrchestrationDomainEventSubscriptionShape
>()("@sats-lab/pulse/orchestration/Services/OrchestrationDomainEventSubscription") {}

export const OrchestrationDomainEventBusLive = Layer.effect(
  OrchestrationDomainEventBus,
  PubSub.unbounded<OrchestrationEvent>(),
);

export const OrchestrationDomainEventSubscriptionLive = Layer.effect(
  OrchestrationDomainEventSubscription,
  Effect.gen(function* () {
    const bus = yield* OrchestrationDomainEventBus;
    return { subscribe: PubSub.subscribe(bus) } satisfies OrchestrationDomainEventSubscriptionShape;
  }),
);
