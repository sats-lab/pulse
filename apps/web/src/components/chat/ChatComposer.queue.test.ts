import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveLatestQueuedInputSnapshot, queuedInputCount } from "./QueuedMessagesPopover";

function activity(input: {
  id: string;
  kind: string;
  payload: unknown;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    kind: input.kind,
    payload: input.payload,
    tone: "info",
    summary: input.kind,
    turnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("deriveLatestQueuedInputSnapshot", () => {
  it("uses the latest queue snapshot and preserves steering and follow-up messages", () => {
    const snapshot = deriveLatestQueuedInputSnapshot([
      activity({
        id: "queue-1",
        kind: "input.queue.updated",
        payload: { steering: ["one"], followUp: ["two", "three"] },
      }),
      activity({ id: "other", kind: "tool.completed", payload: {} }),
      activity({
        id: "queue-2",
        kind: "input.queue.updated",
        payload: { steering: ["latest"], followUp: ["afterward"] },
      }),
    ]);

    expect(snapshot).toEqual({ steering: ["latest"], followUp: ["afterward"] });
    expect(queuedInputCount(snapshot)).toBe(2);
  });

  it("returns an empty snapshot after the provider reports an empty queue", () => {
    const snapshot = deriveLatestQueuedInputSnapshot([
      activity({
        id: "queue-1",
        kind: "input.queue.updated",
        payload: { steering: ["queued"], followUp: [] },
      }),
      activity({
        id: "queue-2",
        kind: "input.queue.updated",
        payload: { steering: [], followUp: [] },
      }),
    ]);

    expect(snapshot).toEqual({ steering: [], followUp: [] });
    expect(queuedInputCount(snapshot)).toBe(0);
  });

  it("ignores invalid queue entries without hiding valid message text", () => {
    expect(
      deriveLatestQueuedInputSnapshot([
        activity({
          id: "queue-invalid",
          kind: "input.queue.updated",
          payload: {
            steering: ["valid steering", null, 42],
            followUp: [{ text: "invalid" }, "valid follow-up"],
          },
        }),
      ]),
    ).toEqual({ steering: ["valid steering"], followUp: ["valid follow-up"] });
  });
});
