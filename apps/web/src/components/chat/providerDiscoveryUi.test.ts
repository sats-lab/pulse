import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderDiscoveryState,
  mergeProviderDiscoveryIntoSnapshot,
} from "./providerDiscoveryUi";

const INSTANCE_ID = ProviderInstanceId.make("pi-work");

function snapshot(): ServerProvider {
  return {
    instanceId: INSTANCE_ID,
    driver: "pi" as ServerProvider["driver"],
    enabled: true,
    installed: true,
    version: "0.82.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [{ name: "compact" }],
    skills: [],
  };
}

describe("provider discovery UI", () => {
  it("maps runtime commands and skills into the selected provider snapshot", () => {
    const discovery = buildProviderDiscoveryState({
      instanceId: INSTANCE_ID,
      commands: [{ name: "review", description: "Review changes" }],
      skills: [
        {
          name: "ui-review",
          description: "Review user interface changes",
          path: "/workspace/.pi/skills/ui-review/SKILL.md",
          scope: "project",
          enabled: true,
        },
      ],
    });

    expect(mergeProviderDiscoveryIntoSnapshot(snapshot(), discovery, INSTANCE_ID)).toMatchObject({
      slashCommands: [{ name: "review", description: "Review changes" }],
      skills: [
        {
          name: "ui-review",
          displayName: "Ui Review",
          shortDescription: "Review user interface changes",
          enabled: true,
        },
      ],
    });
  });

  it("preserves static provider metadata when a discovery source is unavailable", () => {
    const original = snapshot();
    const discovery = buildProviderDiscoveryState({
      instanceId: INSTANCE_ID,
      commands: [],
      skills: [],
    });

    expect(mergeProviderDiscoveryIntoSnapshot(original, discovery, INSTANCE_ID)).toMatchObject({
      slashCommands: [{ name: "compact" }],
      skills: [],
    });
  });

  it("ignores discovery when the provider snapshot no longer matches the selection", () => {
    const original = snapshot();
    const discovery = buildProviderDiscoveryState({
      instanceId: INSTANCE_ID,
      commands: [{ name: "review" }],
      skills: [],
    });

    expect(
      mergeProviderDiscoveryIntoSnapshot(original, discovery, ProviderInstanceId.make("pi-other")),
    ).toBe(original);
  });

  it("ignores discovery results from another provider instance", () => {
    const original = snapshot();
    const discovery = buildProviderDiscoveryState({
      instanceId: ProviderInstanceId.make("pi-other"),
      commands: [{ name: "other" }],
      skills: [],
    });

    expect(mergeProviderDiscoveryIntoSnapshot(original, discovery, INSTANCE_ID)).toBe(original);
  });
});
