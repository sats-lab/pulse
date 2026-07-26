import { describe, expect, it } from "vite-plus/test";

import { EventId } from "@t3tools/contracts";

import {
  deriveLatestContextWindowSnapshot,
  deriveLatestProviderInputQueue,
  formatContextWindowTokens,
  providerInputQueueCount,
} from "./providerRuntimePresentation";

function activity(kind: string, payload: unknown, createdAt = "2026-07-27T00:00:00.000Z") {
  return {
    id: EventId.make(`${kind}-${createdAt}`),
    kind,
    summary: kind,
    tone: "info" as const,
    payload,
    turnId: null,
    createdAt,
  };
}

describe("mobile provider runtime presentation", () => {
  it("uses the latest provider input queue snapshot", () => {
    const snapshot = deriveLatestProviderInputQueue([
      activity("input.queue.updated", { steering: ["old"], followUp: [] }),
      activity("runtime.warning", {}),
      activity(
        "input.queue.updated",
        { steering: ["adjust"], followUp: ["test afterward"] },
        "2026-07-27T00:00:01.000Z",
      ),
    ]);

    expect(snapshot).toEqual({ steering: ["adjust"], followUp: ["test afterward"] });
    expect(providerInputQueueCount(snapshot)).toBe(2);
  });

  it("derives a bounded context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      activity("context-window.updated", {
        usedTokens: 96_000,
        maxTokens: 128_000,
        totalProcessedTokens: 160_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 96_000,
      maxTokens: 128_000,
      remainingTokens: 32_000,
      usedPercentage: 75,
      remainingPercentage: 25,
      compactsAutomatically: true,
    });
    expect(formatContextWindowTokens(snapshot?.usedTokens ?? null)).toBe("96k");
  });
});
