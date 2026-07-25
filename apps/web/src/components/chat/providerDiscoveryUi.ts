import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

export interface RuntimeProviderDiscoveryState {
  readonly instanceId: ProviderInstanceId;
  readonly slashCommands: ReadonlyArray<ServerProvider["slashCommands"][number]>;
  readonly skills: ReadonlyArray<ServerProvider["skills"][number]>;
}

function titleCase(input: string): string {
  return input
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function buildProviderDiscoveryState(input: {
  readonly instanceId: ProviderInstanceId;
  readonly commands: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
    readonly input?: { readonly hint: string } | undefined;
  }>;
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
    readonly path?: string | undefined;
    readonly enabled?: boolean | undefined;
    readonly scope?: string | undefined;
  }>;
}): RuntimeProviderDiscoveryState {
  return {
    instanceId: input.instanceId,
    slashCommands: input.commands.map((command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      ...(command.input ? { input: command.input } : {}),
    })),
    skills: input.skills.map((skill) => {
      const description = skill.description?.trim();
      const shortDescription =
        description && description.length > 100
          ? description.slice(0, 100).replace(/\s+\S*$/, "")
          : description;
      return {
        name: skill.name,
        ...(description ? { description } : {}),
        path: skill.path ?? skill.name,
        ...(skill.scope ? { scope: skill.scope } : {}),
        enabled: skill.enabled ?? true,
        displayName: titleCase(skill.name),
        ...(shortDescription ? { shortDescription } : {}),
      };
    }),
  };
}

export function mergeProviderDiscoveryIntoSnapshot(
  snapshot: ServerProvider | null,
  discovery: RuntimeProviderDiscoveryState | null,
  selectedInstanceId: ProviderInstanceId,
): ServerProvider | null {
  if (
    !snapshot ||
    snapshot.instanceId !== selectedInstanceId ||
    discovery?.instanceId !== selectedInstanceId
  )
    return snapshot;
  return {
    ...snapshot,
    slashCommands:
      discovery.slashCommands.length > 0 ? discovery.slashCommands : snapshot.slashCommands,
    skills: discovery.skills.length > 0 ? discovery.skills : snapshot.skills,
  };
}
