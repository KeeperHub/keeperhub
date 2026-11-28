// The next-block settings' limits and parser. Only the import-free time reader,
// so the step runtime, save-time validation and the editor read them the same way.
import { MAX_UNIX_SECONDS, readUnixTime } from "@/lib/web3/unix-time";

export const MIN_SIMULATE_TIMESTAMP_OFFSET_SEC = 1;
export const MAX_SIMULATE_TIMESTAMP_OFFSET_SEC = 60;

/** The block a Block trigger fired for, from the block scheduler only. */
export type TriggerBlock = { chainId: number; number: number };

type ParsedSimulationSettings =
  | {
      ok: true;
      options: { timestampOffsetSec?: number; atTime?: number } | undefined;
    }
  | {
      ok: false;
      field: "simulateAt" | "simulateTimestampOffsetSec" | "simulateTime";
      error: string;
    };

/** Read Contract's "At a time": the time field's value, strict for a saved literal. */
export type SimulateTimeSetting = { value: unknown; strict: boolean };

const WHOLE_SECONDS = /^\d+$/;

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * Reads `simulateAt` / `simulateTimestampOffsetSec`. `options` is undefined
 * for Latest block (the default); the offset is only read for Next block.
 * "time" is read only where `time` is given (Read Contract), from its value.
 */
export function parseSimulationSettings(
  simulateAt: unknown,
  timestampOffsetSec: unknown,
  time?: SimulateTimeSetting
): ParsedSimulationSettings {
  const mode =
    typeof simulateAt === "string"
      ? simulateAt.trim().toLowerCase()
      : simulateAt;
  if (isUnset(mode) || mode === "latest") {
    return { ok: true, options: undefined };
  }
  if (mode === "time" && time) {
    return parseSimulateTime(time);
  }
  if (mode !== "next-block") {
    return {
      ok: false,
      field: "simulateAt",
      error: `Invalid Simulate at "${String(simulateAt)}": expected ${time ? '"latest", "next-block" or "time"' : '"latest" or "next-block"'}`,
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

function parseSimulateTime(
  time: SimulateTimeSetting
): ParsedSimulationSettings {
  if (isUnset(time.value)) {
    return {
      ok: false,
      field: "simulateTime",
      error: "Enter a time, or set Simulate at to Latest block.",
    };
  }
  const read = readUnixTime(time.value, { strict: time.strict });
  if (!read.ok) {
    return {
      ok: false,
      field: "simulateTime",
      error: `Time (simulateTime) ${JSON.stringify(String(time.value)).slice(0, 60)}: ${read.reason}`,
    };
  }
  // A resolved time past MAX_UNIX_SECONDS reads as that far future.
  return {
    ok: true,
    options: { atTime: Math.min(read.seconds, MAX_UNIX_SECONDS) },
  };
}
