import {
  type PiSettings,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ModelRuntime, Skill as PiSkill } from "@earendil-works/pi-coding-agent";
import { createModelCapabilities } from "@t3tools/shared/model";

import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("pi");

const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
  showRuntimeModeControl: false,
  deferMidTurnUserMessages: true,
  inputQueueMutation: true,
} as const;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const PI_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [
  {
    name: "reload",
    description: "Reload Pi extensions, skills, prompts, themes, tools, and settings",
  },
  {
    name: "compact",
    description: "Manually compact the session context to reduce token usage",
    input: { hint: "Optional instructions for the compaction summary" },
  },
];

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function piSkillToServerProviderSkill(skill: PiSkill): ServerProviderSkill {
  const description = trimToUndefined(skill.description);
  const scope = trimToUndefined(skill.sourceInfo.scope ?? skill.sourceInfo.source);
  const shortDescription =
    description && description.length > 100
      ? description.slice(0, 100).replace(/\s+\S*$/, "")
      : description;
  return {
    name: skill.name,
    ...(description ? { description } : {}),
    path: skill.filePath,
    ...(scope ? { scope } : {}),
    // Pi's disable-model-invocation only hides the skill from the model's
    // system prompt. It remains manually invocable through /skill:name and
    // should therefore remain available in T3's $skill picker.
    enabled: true,
    displayName: titleCase(skill.name),
    ...(shortDescription ? { shortDescription } : {}),
  };
}

interface PiModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Partial<Record<(typeof THINKING_LEVELS)[number], string | null>>;
}

function supportedThinkingLevels(model: PiModel): ReadonlyArray<(typeof THINKING_LEVELS)[number]> {
  if (!model.reasoning) return [];
  const map = model.thinkingLevelMap;
  return THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

export function piModelToServerModel(model: PiModel): ServerProviderModel {
  const levels = supportedThinkingLevels(model);
  const defaultLevel = levels.includes("medium") ? "medium" : levels[0];
  const capabilities = createModelCapabilities({
    optionDescriptors:
      levels.length > 0
        ? [
            {
              id: "thinkingLevel",
              label: "Thinking",
              type: "select" as const,
              options: levels.map((level) => ({
                id: level,
                label: titleCase(level),
                ...(level === defaultLevel ? { isDefault: true } : {}),
              })),
              ...(defaultLevel ? { currentValue: defaultLevel } : {}),
            },
          ]
        : [],
  });

  return {
    slug: `${model.provider}/${model.id}`,
    name: model.name || model.id,
    shortName: model.name || model.id,
    subProvider: titleCase(model.provider),
    isCustom: false,
    capabilities,
  };
}

export const makePendingPiProvider = Effect.fn("makePendingPiProvider")(function* (
  settings: PiSettings,
) {
  const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  return buildServerProvider({
    driver: PROVIDER,
    presentation: PI_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: [],
    slashCommands: PI_SLASH_COMMANDS,
    probe: {
      installed: true,
      version: "0.82.0",
      status: "warning",
      auth: { status: "unknown" },
      message: "Pi provider is starting.",
    },
  });
});

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (input: {
  readonly settings: PiSettings;
  readonly modelRuntime: ModelRuntime;
}): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const available = yield* Effect.promise(() => input.modelRuntime.getAvailable());
  const loadError = input.modelRuntime.getError();
  const models = available.map(piModelToServerModel);
  const hasModels = models.length > 0;

  return buildServerProvider({
    driver: PROVIDER,
    presentation: PI_PRESENTATION,
    enabled: input.settings.enabled,
    checkedAt,
    models,
    slashCommands: PI_SLASH_COMMANDS,
    probe: {
      installed: true,
      version: "0.82.0",
      status: loadError ? "warning" : hasModels ? "ready" : "warning",
      auth: { status: hasModels ? "authenticated" : "unauthenticated" },
      ...(loadError || !hasModels
        ? { message: loadError ?? "No Pi models with configured authentication were found." }
        : {}),
    },
  });
});
