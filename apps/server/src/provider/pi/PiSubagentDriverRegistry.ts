import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { PulseSubagent } from "@t3tools/contracts";
import type {
  SubagentDriver,
  SubagentDriverError,
} from "../../orchestration/Services/SubagentDriver.ts";

export type PiSubagentDriverCapability = (input: {
  readonly subagent: PulseSubagent;
  readonly cwd: string;
}) => Effect.Effect<SubagentDriver, SubagentDriverError>;
export interface PiSubagentDriverRegistryShape {
  readonly get: (id: ProviderInstanceId) => Effect.Effect<PiSubagentDriverCapability | undefined>;
  readonly register: (
    id: ProviderInstanceId,
    capability: PiSubagentDriverCapability,
  ) => Effect.Effect<void>;
  readonly unregister: (
    id: ProviderInstanceId,
    capability: PiSubagentDriverCapability,
  ) => Effect.Effect<void>;
}
export class PiSubagentDriverRegistry extends Context.Service<
  PiSubagentDriverRegistry,
  PiSubagentDriverRegistryShape
>()("@sats-lab/pulse/provider/pi/PiSubagentDriverRegistry") {}
export const PiSubagentDriverRegistryLive = Layer.effect(
  PiSubagentDriverRegistry,
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, PiSubagentDriverCapability>>(
      new Map(),
    );
    return {
      get: (id) => Ref.get(entries).pipe(Effect.map((map) => map.get(id))),
      register: (id, capability) => Ref.update(entries, (map) => new Map(map).set(id, capability)),
      unregister: (id, capability) =>
        Ref.update(entries, (map) => {
          if (map.get(id) !== capability) return map;
          const next = new Map(map);
          next.delete(id);
          return next;
        }),
    } satisfies PiSubagentDriverRegistryShape;
  }),
);
