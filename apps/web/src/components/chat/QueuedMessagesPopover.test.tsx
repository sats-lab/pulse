import type { ProviderInputQueueMutation } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { QueueSection } from "./QueuedMessagesPopover";

describe("QueuedMessagesPopover queue controls", () => {
  it("renders clear-all, section, and individual removal controls", () => {
    const mutations: ProviderInputQueueMutation[] = [];
    const markup = renderToStaticMarkup(
      <>
        <button type="button" aria-label="Clear all queued messages">
          Clear all
        </button>
        <QueueSection
          mode="steer"
          messages={["steer one", "steer two"]}
          canMutate
          isMutating={false}
          onMutate={(mutation) => mutations.push(mutation)}
        />
        <QueueSection
          mode="followUp"
          messages={["follow later"]}
          canMutate
          isMutating={false}
          onMutate={(mutation) => mutations.push(mutation)}
        />
      </>,
    );

    expect(markup).toContain('aria-label="Clear all queued messages"');
    expect(markup).toContain('aria-label="Clear steering queue"');
    expect(markup).toContain('aria-label="Clear follow-up queue"');
    expect(markup).toContain('aria-label="Remove queued steering message 1"');
    expect(markup).toContain('aria-label="Remove queued steering message 2"');
    expect(markup).toContain('aria-label="Remove queued follow-up message 1"');
  });

  it("disables queue controls while a mutation is pending", () => {
    const markup = renderToStaticMarkup(
      <QueueSection
        mode="steer"
        messages={["steer one"]}
        canMutate
        isMutating
        onMutate={() => undefined}
      />,
    );

    expect(markup).toMatch(/disabled=""[^>]+aria-label="Clear steering queue"/);
    expect(markup).toMatch(/disabled=""[^>]+aria-label="Remove queued steering message 1"/);
  });
});
