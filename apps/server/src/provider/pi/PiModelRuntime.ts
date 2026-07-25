import type { PiSettings, ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

export interface PiModelRuntimeResources {
  readonly modelRuntime: ModelRuntime;
  readonly agentDir: string | undefined;
  readonly environment: Record<string, string>;
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Create one isolated Pi ModelRuntime for a provider instance.
 *
 * Pi 0.82 accepts credential/model paths explicitly, so this never mutates
 * process.env. Instance environment variables are retained for provider request
 * overrides used by the adapter and text-generation paths.
 */
export const makePiModelRuntime = Effect.fn("makePiModelRuntime")(function* (input: {
  readonly settings: PiSettings;
  readonly environment: ProviderInstanceEnvironment;
}) {
  const path = yield* Path.Path;
  const agentDir = nonEmpty(input.settings.agentDir);
  const environment = Object.fromEntries(
    Object.entries(mergeProviderInstanceEnvironment(input.environment)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const modelRuntime = yield* Effect.promise(() =>
    ModelRuntime.create({
      ...(agentDir
        ? {
            authPath: path.join(agentDir, "auth.json"),
            modelsPath: path.join(agentDir, "models.json"),
            modelsStorePath: path.join(agentDir, "models-cache.json"),
          }
        : {}),
      allowModelNetwork: false,
    }),
  );

  return {
    modelRuntime,
    agentDir,
    environment,
  } satisfies PiModelRuntimeResources;
});
