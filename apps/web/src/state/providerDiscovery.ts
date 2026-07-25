import { createProviderDiscoveryEnvironmentAtoms } from "@t3tools/client-runtime/state/provider-discovery";

import { connectionAtomRuntime } from "../connection/runtime";

export const providerDiscoveryEnvironment =
  createProviderDiscoveryEnvironmentAtoms(connectionAtomRuntime);
