import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { PiSubagentDriverRegistry } from "../../provider/pi/PiSubagentDriverRegistry.ts";
import { SubagentDriverError } from "../Services/SubagentDriver.ts";
import {
  SubagentDriverFactoryService,
  type SubagentDriverFactory,
} from "./SubagentExecutionReactor.ts";

export const PiSubagentDriverFactoryLive = Layer.effect(
  SubagentDriverFactoryService,
  Effect.gen(function* () {
    const instances = yield* ProviderInstanceRegistry;
    const capabilities = yield* PiSubagentDriverRegistry;
    const attach: SubagentDriverFactory["attach"] = Effect.fn("PiSubagentDriverFactory.attach")(
      function* ({ subagent, cwd }) {
        const id = ProviderInstanceId.make(subagent.metadata.providerInstanceId);
        const instance = yield* instances.getInstance(id);
        if (!instance)
          return yield* new SubagentDriverError({
            subagentId: subagent.id,
            message: `Unknown provider instance '${id}'.`,
          });
        if (!instance.enabled)
          return yield* new SubagentDriverError({
            subagentId: subagent.id,
            message: `Provider instance '${id}' is disabled.`,
          });
        if (instance.driverKind !== "pi")
          return yield* new SubagentDriverError({
            subagentId: subagent.id,
            message: `Provider instance '${id}' is not Pi.`,
          });
        const capability = yield* capabilities.get(id);
        if (!capability)
          return yield* new SubagentDriverError({
            subagentId: subagent.id,
            message: `Pi provider instance '${id}' is not ready.`,
          });
        return yield* capability({ subagent, cwd });
      },
    );
    return { attach };
  }),
);
