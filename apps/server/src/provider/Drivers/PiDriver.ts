import { PiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter } from "../pi/PiAdapter.ts";
import { checkPiProviderStatus, makePendingPiProvider } from "../Layers/PiProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { makePiModelRuntime } from "../pi/PiModelRuntime.ts";
import { makePiSubagentDriver } from "../pi/PiSubagentDriver.ts";
import { PiSubagentDriverRegistry } from "../pi/PiSubagentDriverRegistry.ts";
import { PulseSubagentsRuntimeBridge } from "../pi/PulseSubagentsRuntimeBridge.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const decodePiSettings = Schema.decodeSync(PiSettings);

export type PiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService
  | PiSubagentDriverRegistry
  | PulseSubagentsRuntimeBridge;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

/** Pi driver bootstrap on the 0.82 ModelRuntime and AgentSession APIs. */
export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const runtime = yield* makePiModelRuntime({ settings: effectiveConfig, environment });
      const serverSettings = yield* ServerSettingsService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const subagentRegistry = yield* PiSubagentDriverRegistry;
      const capability = (input: {
        readonly subagent: import("@t3tools/contracts").PulseSubagent;
        readonly cwd: string;
      }) =>
        Effect.gen(function* () {
          const childScope = yield* Scope.make();
          return yield* makePiSubagentDriver({
            ...input,
            settings: effectiveConfig,
            modelRuntime: runtime.modelRuntime,
            environment: runtime.environment,
            instanceId,
            scope: childScope,
            modelSlug: input.subagent.metadata.model,
            fileSystem,
            path,
            serverConfig,
          });
        });
      yield* subagentRegistry.register(instanceId, capability);
      yield* Effect.addFinalizer(() => subagentRegistry.unregister(instanceId, capability));
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: "@earendil-works/pi-coding-agent",
      });
      const bridge = yield* PulseSubagentsRuntimeBridge;
      const effectContext = yield* Effect.context<never>();
      const runPromiseWith = Effect.runPromiseWith(effectContext);
      const adapter = yield* makePiAdapter(effectiveConfig, {
        instanceId,
        modelRuntime: runtime.modelRuntime,
        environment: runtime.environment,
        resolvePulseSubagents: (context) =>
          context.turnId
            ? runPromiseWith(
                bridge.resolve({
                  threadId: context.threadId,
                  turnId: context.turnId,
                  providerInstanceId: instanceId,
                  cwd: context.cwd,
                  ...(context.modelSelection?.model
                    ? {
                        modelSelection: {
                          instanceId,
                          model: context.modelSelection.model,
                          ...(context.modelSelection.options
                            ? { options: context.modelSelection.options }
                            : {}),
                        },
                      }
                    : {}),
                }),
              )
            : Promise.reject(new Error("pulse_subagents requires an active parent turn.")),
      });
      const textGeneration = yield* makePiTextGeneration({
        settings: effectiveConfig,
        modelRuntime: runtime.modelRuntime,
        environment: runtime.environment,
      });
      const checkProvider = checkPiProviderStatus({
        settings: effectiveConfig,
        modelRuntime: runtime.modelRuntime,
      }).pipe(Effect.map(stampIdentity));
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingPiProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
