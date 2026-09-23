/**
 * Size limit for a run's or step's stored input and output.
 *
 * Step outputs are JSONB rows that every read of a run pulls back whole, and
 * the app serialises them again for each response. A single step that stores
 * a very large body therefore costs that much memory on every listing, log
 * view and poll that touches its run, in the pod that answers it. The limit is
 * enforced twice: reads replace an oversized value with a marker, and writes
 * refuse to persist one.
 *
 * The marker shape is the one the logs endpoint already uses for its
 * `truncateData` option, so clients that handle that handle this.
 */
export const MAX_STORED_OUTPUT_BYTES = 1_048_576;

/** How much of an oversized value's text a read-side marker keeps. */
export const TRUNCATED_PREVIEW_CHARS = 1024;

export type TruncatedOutputMarker = {
  _truncated: true;
  originalSize: number;
  preview: string;
};

export function isTruncatedOutput(
  value: unknown
): value is TruncatedOutputMarker {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate._truncated === true &&
    typeof candidate.originalSize === "number" &&
    typeof candidate.preview === "string"
  );
}

export function formatStoredBytes(bytes: number): string {
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KiB`;
  }
  return `${bytes} bytes`;
}
