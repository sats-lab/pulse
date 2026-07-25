import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createProviderDiscoveryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    composerCapabilities: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:provider:composer-capabilities",
      tag: WS_METHODS.providerGetComposerCapabilities,
      staleTimeMs: 30_000,
    }),
    skills: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:provider:skills",
      tag: WS_METHODS.providerListSkills,
      staleTimeMs: 30_000,
    }),
    commands: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:provider:commands",
      tag: WS_METHODS.providerListCommands,
      staleTimeMs: 30_000,
    }),
  };
}
