import {
  type ChatAttachment,
  type ModelSelection,
  type PiSettings,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  createAgentSession,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import type { BranchNameGenerationInput, TextGeneration } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PROVIDER_LABEL = "Pi SDK";

type PiTextGenerationOptions = {
  readonly settings: PiSettings;
  readonly modelRuntime: ModelRuntime;
  readonly environment: Record<string, string>;
};

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePiModelSlug(slug: string): { provider: string; modelId: string } | null {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

const resolvePiModel = Effect.fn("resolvePiTextGenerationModel")(function* (
  operation: string,
  modelRuntime: ModelRuntime,
  modelSelection: ModelSelection,
) {
  const parsed = parsePiModelSlug(modelSelection.model);
  if (!parsed) {
    return yield* new TextGenerationError({
      operation,
      detail: "Pi model selection must use the 'provider/model' format.",
    });
  }
  const model = modelRuntime.getModel(parsed.provider, parsed.modelId);
  const auth = yield* Effect.tryPromise({
    try: () => modelRuntime.getAuth(parsed.provider),
    catch: (cause) => new TextGenerationError({ operation, detail: errorDetail(cause), cause }),
  });
  if (!model || !auth) {
    return yield* new TextGenerationError({
      operation,
      detail: `Pi model '${modelSelection.model}' is unavailable or missing authentication.`,
    });
  }
  return model;
});

function extractText(messages: ReadonlyArray<unknown>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const record = message as { readonly role?: unknown; readonly content?: unknown };
    if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
    return record.content
      .flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const value = part as { readonly type?: unknown; readonly text?: unknown };
        return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
      })
      .join("");
  }
  return "";
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced?.startsWith("{") && fenced.endsWith("}")) return fenced;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  options: PiTextGenerationOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;

  const materializeImages = Effect.fn("materializePiTextGenerationImages")(function* (
    operation: "generateBranchName" | "generateThreadTitle",
    attachments: BranchNameGenerationInput["attachments"],
  ) {
    const images = yield* Effect.forEach(
      attachments ?? [],
      (attachment: ChatAttachment) =>
        Effect.gen(function* () {
          if (attachment.type !== "image") return null;
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) return null;
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: `Failed to read attachment file: ${cause.message}.`,
                  cause,
                }),
            ),
          );
          return {
            type: "image" as const,
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          };
        }),
      { concurrency: 1 },
    );
    return images.filter((image) => image !== null);
  });

  const runPiJson = Effect.fn("runPiJson")(function* <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly images?: ReadonlyArray<{ type: "image"; data: string; mimeType: string }>;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const model = yield* resolvePiModel(
      input.operation,
      options.modelRuntime,
      input.modelSelection,
    );
    const rawOutput = yield* Effect.tryPromise({
      try: async () => {
        const { session } = await createAgentSession({
          cwd: input.cwd,
          ...(options.settings.agentDir ? { agentDir: options.settings.agentDir } : {}),
          modelRuntime: options.modelRuntime,
          model,
          sessionManager: SessionManager.inMemory(input.cwd),
          noTools: "all",
        });
        try {
          // Provider environment is scoped to request resolution rather than
          // mutating process.env. Resolve once to validate these overrides.
          await options.modelRuntime.getAuth(model, { env: options.environment });
          await session.prompt(
            input.prompt,
            input.images?.length ? { images: [...input.images] } : undefined,
          );
          const output = extractText(session.messages as ReadonlyArray<unknown>);
          if (output.trim().length === 0)
            throw new Error(`${PROVIDER_LABEL} returned empty output.`);
          return output;
        } finally {
          session.dispose();
        }
      },
      catch: (cause) =>
        new TextGenerationError({ operation: input.operation, detail: errorDetail(cause), cause }),
    });

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
      Effect.catchTag(
        "SchemaError",
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: `${PROVIDER_LABEL} returned invalid structured output.`,
            cause,
          }),
      ),
    );
  });

  const generateCommitMessage: TextGeneration["Service"]["generateCommitMessage"] = Effect.fn(
    "PiTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runPiJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGeneration["Service"]["generatePrContent"] = Effect.fn(
    "PiTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt(input);
    const generated = yield* runPiJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: TextGeneration["Service"]["generateBranchName"] = Effect.fn(
    "PiTextGeneration.generateBranchName",
  )(function* (input) {
    const images = yield* materializeImages("generateBranchName", input.attachments);
    const { prompt, outputSchema } = buildBranchNamePrompt(input);
    const generated = yield* runPiJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      images,
    });
    return { branch: sanitizeFeatureBranchName(generated.branch) };
  });

  const generateThreadTitle: TextGeneration["Service"]["generateThreadTitle"] = Effect.fn(
    "PiTextGeneration.generateThreadTitle",
  )(function* (input) {
    const images = yield* materializeImages("generateThreadTitle", input.attachments);
    const { prompt, outputSchema } = buildThreadTitlePrompt(input);
    const generated = yield* runPiJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      images,
    });
    return { title: sanitizeThreadTitle(generated.title) };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration["Service"];
});
