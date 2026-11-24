// The next-block settings' limits and parser. No imports, so the step runtime,
// save-time validation and the editor all read the settings the same way.
export const MIN_SIMULATE_TIMESTAMP_OFFSET_SEC = 1;
export const MAX_SIMULATE_TIMESTAMP_OFFSET_SEC = 60;

export type ParsedSimulationSettings =
  | { ok: true; options: { timestampOffsetSec?: number } | undefined }
  | {
      ok: false;
      field: "simulateAt" | "simulateTimestampOffsetSec";
      error: string;
    };

const WHOLE_SECONDS = /^\d+$/;

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * Reads `simulateAt` / `simulateTimestampOffsetSec`. `options` is undefined
 * for Latest block (the default); the offset is only read for Next block.
 */
export function parseSimulationSettings(
  simulateAt: unknown,
  timestampOffsetSec: unknown
): ParsedSimulationSettings {
  const mode =
    typeof simulateAt === "string"
      ? simulateAt.trim().toLowerCase()
      : simulateAt;
  if (isUnset(mode) || mode === "latest") {
    return { ok: true, options: undefined };
  }
  if (mode !== "next-block") {
    return {
      ok: false,
      field: "simulateAt",
      error: `Invalid Simulate at "${String(simulateAt)}": expected "latest" or "next-block"`,
    };
  }
  if (isUnset(timestampOffsetSec)) {
    return { ok: true, options: {} };
  }
  const text = String(timestampOffsetSec).trim();
  const offset = Number(text);
  if (
    !WHOLE_SECONDS.test(text) ||
    offset < MIN_SIMULATE_TIMESTAMP_OFFSET_SEC ||
    offset > MAX_SIMULATE_TIMESTAMP_OFFSET_SEC
  ) {
    return {
      ok: false,
      field: "simulateTimestampOffsetSec",
      error: `Invalid Next block timestamp offset "${text}": expected a whole number of seconds from ${MIN_SIMULATE_TIMESTAMP_OFFSET_SEC} to ${MAX_SIMULATE_TIMESTAMP_OFFSET_SEC}`,
    };
  }
  return { ok: true, options: { timestampOffsetSec: offset } };
}

/** Whether the config asks for Next block (a valid setting only). */
export function simulatesNextBlock(config: Record<string, unknown>): boolean {
  const parsed = parseSimulationSettings(config.simulateAt, undefined);
  return parsed.ok && parsed.options !== undefined;
}
