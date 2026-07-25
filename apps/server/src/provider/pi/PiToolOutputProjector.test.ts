import { describe, expect, it } from "vite-plus/test";

import { makePiToolTextProjector, projectPiToolResult } from "./PiToolOutputProjector.ts";

describe("PiToolOutputProjector", () => {
  it("emits only suffixes for cumulative snapshots", () => {
    const projector = makePiToolTextProjector();
    expect(projector.project({ text: "one" })).toEqual({ kind: "append", text: "one" });
    expect(projector.project({ text: "one two" })).toEqual({ kind: "append", text: " two" });
    expect(projector.project({ text: "one two" })).toEqual({ kind: "none" });
  });

  it("handles rolling truncated tails without duplicating their overlap", () => {
    const projector = makePiToolTextProjector({ maxRetainedTextBytes: 64 });
    expect(
      projector.project({ text: "line-1\nline-2\nline-3\n", totalBytes: 21, truncated: true }),
    ).toEqual({ kind: "append", text: "line-1\nline-2\nline-3\n" });
    expect(
      projector.project({ text: "line-2\nline-3\nline-4\n", totalBytes: 28, truncated: true }),
    ).toEqual({ kind: "append", text: "line-4\n" });
  });

  it("uses replacement for non-monotonic snapshots", () => {
    const projector = makePiToolTextProjector();
    projector.project({ text: "running" });
    expect(projector.project({ text: "reset" })).toEqual({ kind: "replace", text: "reset" });
  });

  it("keeps retained state bounded while total output grows", () => {
    const projector = makePiToolTextProjector({ maxRetainedTextBytes: 32 });
    let cumulative = "";
    let emittedBytes = 0;
    for (let index = 0; index < 10_000; index += 1) {
      cumulative += "x";
      const projection = projector.project({ text: cumulative });
      if (projection.kind !== "none") emittedBytes += Buffer.byteLength(projection.text);
    }
    expect(emittedBytes).toBe(10_000);
    expect(projector.getRetainedByteLength()).toBeLessThanOrEqual(32);
  });

  it("projects bounded content/details instead of recursively diffing arbitrary values", () => {
    expect(
      projectPiToolResult({
        content: [{ type: "text", text: "ok" }],
        details: { exitCode: 0 },
        ignored: { arbitrarily: "large provider-specific state" },
      }),
    ).toEqual({
      content: [{ type: "text", text: "ok" }],
      details: { exitCode: 0 },
    });
    expect(
      projectPiToolResult({ details: { output: "x".repeat(100) } }, { maxProjectedValueBytes: 8 }),
    ).toBeUndefined();
  });
});
