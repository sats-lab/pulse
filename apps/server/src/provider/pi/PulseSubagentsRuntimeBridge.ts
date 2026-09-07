import type {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationDomainEventSubscription } from "../../orchestration/Services/OrchestrationDomainEventSubscription.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionSubagentRepository } from "../../persistence/Services/ProjectionSubagents.ts";
import type { PulseSubagentsToolInput } from "./PulseSubagentsTool.ts";

export interface PulseSubagentsSessionContext {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly modelSelection?: ModelSelection;
}
export class PulseSubagentsRuntimeUnavailableError extends Error {
  readonly _tag = "PulseSubagentsRuntimeUnavailableError" as const;
}

export interface PulseSubagentsRuntimeBridgeShape {
  readonly resolve: (
    context: PulseSubagentsSessionContext,
  ) => Effect.Effect<
    Omit<PulseSubagentsToolInput, "run" | "randomUUID">,
    PulseSubagentsRuntimeUnavailableError
  >;
}
export class PulseSubagentsRuntimeBridge extends Context.Service<
  PulseSubagentsRuntimeBridge,
  PulseSubagentsRuntimeBridgeShape
>()("@sats-lab/pulse/provider/pi/PulseSubagentsRuntimeBridge") {}

export const PulseSubagentsRuntimeBridgeLive = Layer.effect(
  PulseSubagentsRuntimeBridge,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const eventSubscription = yield* OrchestrationDomainEventSubscription;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const repository = yield* ProjectionSubagentRepository;
    const resolve = Effect.fn("resolvePulseSubagents")((context: PulseSubagentsSessionContext) =>
      Effect.gen(function* () {
        const thread = yield* snapshotQuery
          .getThreadDetailById(context.threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new PulseSubagentsRuntimeUnavailableError(
                  `pulse_subagents unavailable: ${cause.message}`,
                ),
            ),
          );
        if (thread._tag === "None") {
          return yield* Effect.fail(
            new PulseSubagentsRuntimeUnavailableError("pulse_subagents requires a project."),
          );
        }
        return {
          projectId: thread.value.projectId,
          threadId: context.threadId,
          turnId: context.turnId,
          providerInstanceId: context.providerInstanceId,
          cwd: context.cwd,
          ...(context.modelSelection ? { modelSelection: context.modelSelection } : {}),
          engine,
          eventSubscription,
          repository,
        };
      }),
    );
    return PulseSubagentsRuntimeBridge.of({ resolve });
  }),
);
