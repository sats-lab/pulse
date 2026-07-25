const DEFAULT_MAX_RETAINED_TEXT_BYTES = 64 * 1024;
const DEFAULT_MAX_PROJECTED_VALUE_BYTES = 128 * 1024;

export interface PiToolTextSnapshot {
  readonly text: string | undefined;
  readonly totalBytes?: number | undefined;
  readonly truncated?: boolean | undefined;
}

export type PiToolTextProjection =
  | { readonly kind: "none" }
  | { readonly kind: "append"; readonly text: string }
  | { readonly kind: "replace"; readonly text: string };

export interface PiToolTextProjector {
  readonly project: (snapshot: PiToolTextSnapshot) => PiToolTextProjection;
  readonly getRetainedByteLength: () => number;
  readonly getMaterializedText: () => string;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function trimUtf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function longestSuffixPrefixOverlap(previous: string, next: string): number {
  const combined = `${next}\u0000${previous}`;
  const prefix = new Uint32Array(combined.length);
  for (let index = 1; index < combined.length; index += 1) {
    let candidate = prefix[index - 1]!;
    while (candidate > 0 && combined[index] !== combined[candidate]) {
      candidate = prefix[candidate - 1]!;
    }
    if (combined[index] === combined[candidate]) candidate += 1;
    prefix[index] = candidate;
  }
  return Math.min(prefix[combined.length - 1] ?? 0, next.length);
}

/**
 * Project cumulative Pi tool snapshots into bounded append/replace operations.
 *
 * The retained text window is bounded, so prefix/overlap comparisons are O(1)
 * with respect to total command output. Pi's rolling truncated tail is handled
 * with a suffix/prefix overlap instead of appending the full tail again.
 *
 * WARNING: bounded retention and emission do not guarantee bounded CPU for an
 * arbitrary producer. Pi's tool update contract supplies a complete
 * `partialResult`, not an output delta. If an extension repeatedly supplies an
 * unbounded cumulative string, reading and trimming each already-materialized
 * snapshot can still produce O(n²) total work across the stream. Pi's built-in
 * bash tool eventually emits bounded rolling snapshots, limiting that risk.
 * A true near-linear guarantee requires the producer/SDK to expose output
 * deltas; this projector is only a compatibility fallback for snapshot events.
 */
export function makePiToolTextProjector(options?: {
  readonly maxRetainedTextBytes?: number | undefined;
}): PiToolTextProjector {
  const maxRetainedTextBytes = Math.max(
    1,
    options?.maxRetainedTextBytes ?? DEFAULT_MAX_RETAINED_TEXT_BYTES,
  );
  let previousTail = "";
  let previousSnapshotLength = 0;
  let previousTotalBytes: number | undefined;
  let previousWasTruncated = false;
  let materializedText = "";

  return {
    project(snapshot) {
      if (snapshot.text === undefined) return { kind: "none" };
      const next = snapshot.text;
      const nextTail = trimUtf8Tail(next, maxRetainedTextBytes);
      const nextTotalBytes = snapshot.totalBytes;
      const isTruncated = snapshot.truncated === true;

      if (
        next.length === previousSnapshotLength &&
        nextTail === previousTail &&
        isTruncated === previousWasTruncated
      ) {
        previousTotalBytes = nextTotalBytes ?? previousTotalBytes;
        return { kind: "none" };
      }

      let projection: PiToolTextProjection;
      if (previousSnapshotLength === 0) {
        projection = next.length > 0 ? { kind: "append", text: next } : { kind: "none" };
      } else if (!isTruncated && !previousWasTruncated && next.length > previousSnapshotLength) {
        // Untruncated Pi snapshots are cumulative. Slice by the prior logical
        // length instead of scanning the growing prefix with startsWith().
        const suffix = next.slice(previousSnapshotLength);
        projection = suffix.length > 0 ? { kind: "append", text: suffix } : { kind: "none" };
      } else if (
        isTruncated ||
        (nextTotalBytes !== undefined &&
          previousTotalBytes !== undefined &&
          nextTotalBytes >= previousTotalBytes)
      ) {
        const overlap = longestSuffixPrefixOverlap(previousTail, next);
        const suffix = next.slice(overlap);
        projection = suffix.length > 0 ? { kind: "append", text: suffix } : { kind: "none" };
      } else {
        projection = { kind: "replace", text: next };
      }

      previousTail = nextTail;
      previousSnapshotLength = next.length;
      previousTotalBytes = nextTotalBytes ?? previousTotalBytes;
      previousWasTruncated = isTruncated;
      if (projection.kind === "append") {
        materializedText = trimUtf8Tail(
          `${materializedText}${projection.text}`,
          maxRetainedTextBytes,
        );
      } else if (projection.kind === "replace") {
        materializedText = trimUtf8Tail(projection.text, maxRetainedTextBytes);
      }
      return projection;
    },
    getRetainedByteLength: () => utf8ByteLength(previousTail),
    getMaterializedText: () => materializedText,
  };
}

export interface PiProjectedToolResult {
  readonly content?: ReadonlyArray<unknown> | undefined;
  readonly details?: unknown;
}

function boundedJsonValue(value: unknown, maxBytes: number): unknown | undefined {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || utf8ByteLength(encoded) > maxBytes) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Keep only bounded UI-relevant structured fields from a Pi tool result.
 * Arbitrary extension details are deliberately not recursively diffed.
 *
 * WARNING: the byte limit bounds what is retained, not the cost of inspecting
 * an input. `JSON.stringify` must still visit the complete value before its
 * encoded size is known, so repeatedly supplied cumulative extension details
 * can also cause super-linear aggregate CPU work. Producers should emit bounded
 * metadata or native deltas rather than growing structured snapshots.
 */
export function projectPiToolResult(
  value: unknown,
  options?: { readonly maxProjectedValueBytes?: number | undefined },
): PiProjectedToolResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const maxBytes = Math.max(
    1,
    options?.maxProjectedValueBytes ?? DEFAULT_MAX_PROJECTED_VALUE_BYTES,
  );
  const content = Array.isArray(record.content)
    ? boundedJsonValue(record.content, maxBytes)
    : undefined;
  const details = boundedJsonValue(record.details, maxBytes);
  if (content === undefined && details === undefined) return undefined;
  return {
    ...(Array.isArray(content) ? { content } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}
