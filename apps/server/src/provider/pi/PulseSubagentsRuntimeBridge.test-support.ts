import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PulseSubagentsRuntimeBridge,
  PulseSubagentsRuntimeUnavailableError,
} from "./PulseSubagentsRuntimeBridge.ts";

export const PulseSubagentsRuntimeBridgeTestLive = Layer.succeed(
  PulseSubagentsRuntimeBridge,
  PulseSubagentsRuntimeBridge.of({
    resolve: () =>
      Effect.fail(
        new PulseSubagentsRuntimeUnavailableError("pulse_subagents is unavailable in this test"),
      ),
  }),
);
