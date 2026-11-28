import {
  MAX_UNIX_SECONDS,
  MIN_UNIX_SECONDS,
  readUnixTime,
} from "@/lib/web3/unix-time";
import { BUNDLE_STEP_ACTION_TYPES } from "@/lib/workflow/executor/run-outcome-keys";

/** Most blocks a bundle step may target; each adds about 12 s while the wallet is held. */
export const MAX_BUNDLE_BLOCKS = 5;
export const DEFAULT_BUNDLE_BLOCKS = 3;
/** Most blocks before the first allowed block a step may send; with Target blocks at most MAX_BUNDLE_BLOCKS. */
export const MAX_SEND_AHEAD_BLOCKS = 3;
export const DEFAULT_SEND_AHEAD_BLOCKS = 2;
export const MAX_TIP_INCREASE_PERCENT = 100;
export const MAX_SELECTED_BUILDERS = 16;

/** The config keys of a bundle step's settings. */
export const BUNDLE_SETTING_KEYS = {
  blocks: "bundleBlocks",
  tipIncreasePercent: "bundleTipIncreasePercent",
  builders: "bundleBuilders",
  notBefore: "notBefore",
  sendAheadBlocks: "sendAheadBlocks",
} as const;

/** Not before needs a fixed slot length (a beacon chain) to know which blocks cannot be early. */
export const NOT_BEFORE_UNSUPPORTED_ERROR =
  "Not before is not supported on this network.";

/** Set by the executor when the saved Not before was a template, so an empty value fails the step. */
export const NOT_BEFORE_FROM_TEMPLATE_KEY = "_notBeforeFromTemplate";

/** The editor labels of those keys, so errors name both. */
export const BUNDLE_SETTING_LABELS = {
  blocks: "Target blocks",
  tipIncreasePercent: "Tip increase per block (%)",
  builders: "Builders",
  notBefore: "Not before",
  sendAheadBlocks: "Send ahead (blocks)",
} as const;

// How the editor names the seeded builders; the stored value stays the name.
const BUILDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  flashbots: "Flashbots",
  buildernet: "BuilderNet",
  titan: "Titan",
  beaverbuild: "beaverbuild",
  quasar: "Quasar",
  btcs: "BTCS",
  eureka: "Eureka",
};

/** A builder's display name; an unknown one shows as stored. */
export function builderDisplayName(name: string): string {
  return BUILDER_DISPLAY_NAMES[name] ?? name;
}

/** Not before as a step runs it: unix seconds, and how many blocks ahead it may send. */
export type SendAhead = { notBefore: number; blocks: number };

/** A bundle step's settings, as it sends them. */
export type BundleSettings = {
  blocks: number;
  tipIncreasePercent: number;
  // Builder names; undefined means every builder of the network.
  builders?: string[];
  // Only with Not before set (at save, only when it is not a template).
  sendAhead?: SendAhead;
  // At run only: why Not before cannot be used. The step fails with it after its in-flight check.
  notBeforeRefusal?: string;
};

export type BundleSettingsInput = {
  bundleBlocks?: unknown;
  bundleTipIncreasePercent?: unknown;
  bundleBuilders?: unknown;
  notBefore?: unknown;
  sendAheadBlocks?: unknown;
  [NOT_BEFORE_FROM_TEMPLATE_KEY]?: unknown;
};

/** A save reads a template as unknown until the run; a run reads its resolved value. */
export type SettingsPhase = "save" | "run";

const INTEGER_RE = /^\d+$/;
const TEMPLATE_MARK = "{{";
// Longest value an error quotes back.
const MAX_QUOTED_CHARS = 40;

/** The executor's mark on a step whose saved Not before is a template. Mutates `processed`. */
export function markTemplatedNotBefore(
  actionType: string,
  saved: Record<string, unknown>,
  processed: Record<string, unknown>
): void {
  const value = saved[BUNDLE_SETTING_KEYS.notBefore];
  if (
    BUNDLE_STEP_ACTION_TYPES.includes(actionType) &&
    typeof value === "string" &&
    value.includes(TEMPLATE_MARK)
  ) {
    processed[NOT_BEFORE_FROM_TEMPLATE_KEY] = true;
  }
}

export function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** A whole number in range, from a number or its decimal text; else undefined. */
export function readInteger(
  value: unknown,
  range: { min: number; max: number }
): number | undefined {
  let parsed: number | undefined;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && INTEGER_RE.test(value.trim())) {
    parsed = Number(value.trim());
  }
  return parsed !== undefined &&
    Number.isInteger(parsed) &&
    parsed >= range.min &&
    parsed <= range.max
    ? parsed
    : undefined;
}

/**
 * A list of names, as an array or its JSON text: trimmed, each once, no
 * templates, at most `max`. Empty means all (undefined); null when malformed.
 */
export function readNameList(
  value: unknown,
  max: number | undefined
): string[] | undefined | null {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list) || (max !== undefined && list.length > max)) {
    return null;
  }
  const names: string[] = [];
  for (const entry of list) {
    if (
      typeof entry !== "string" ||
      entry.trim() === "" ||
      entry.includes(TEMPLATE_MARK)
    ) {
      return null;
    }
    names.push(entry.trim());
  }
  return names.length === 0 ? undefined : [...new Set(names)];
}

/** The picked builder names: undefined means every builder, null a malformed list. */
function readBuilderNames(value: unknown): string[] | undefined | null {
  return isUnset(value)
    ? undefined
    : readNameList(value, MAX_SELECTED_BUILDERS);
}

/** Text echoed back, cut to a short length. */
export function shortened(text: string): string {
  return text.length > MAX_QUOTED_CHARS
    ? `${text.slice(0, MAX_QUOTED_CHARS)}...`
    : text;
}

/** A value echoed in a message, JSON-quoted and cut to a short length. */
export function quoted(value: unknown): string {
  return shortened(JSON.stringify(value) ?? String(value));
}

type SettingsRead =
  | { ok: true; settings: BundleSettings }
  | { ok: false; error: string; field: string };

/** The step's bundle settings with their defaults, or the reason one is wrong. */
export function readBundleSettings(
  input: BundleSettingsInput,
  phase: SettingsPhase = "run"
): SettingsRead {
  const blocks = isUnset(input.bundleBlocks)
    ? DEFAULT_BUNDLE_BLOCKS
    : readInteger(input.bundleBlocks, { min: 1, max: MAX_BUNDLE_BLOCKS });
  if (blocks === undefined) {
    return {
      ok: false,
      field: BUNDLE_SETTING_KEYS.blocks,
      error: `${BUNDLE_SETTING_LABELS.blocks} (bundleBlocks) must be a whole number from 1 to ${MAX_BUNDLE_BLOCKS}, not ${quoted(input.bundleBlocks)}.`,
    };
  }
  const tipIncreasePercent = isUnset(input.bundleTipIncreasePercent)
    ? 0
    : readInteger(input.bundleTipIncreasePercent, {
        min: 0,
        max: MAX_TIP_INCREASE_PERCENT,
      });
  if (tipIncreasePercent === undefined) {
    return {
      ok: false,
      field: BUNDLE_SETTING_KEYS.tipIncreasePercent,
      error: `${BUNDLE_SETTING_LABELS.tipIncreasePercent} (bundleTipIncreasePercent) must be a whole number from 0 to ${MAX_TIP_INCREASE_PERCENT}, not ${quoted(input.bundleTipIncreasePercent)}.`,
    };
  }
  const builders = readBuilderNames(input.bundleBuilders);
  if (builders === null) {
    return {
      ok: false,
      field: BUNDLE_SETTING_KEYS.builders,
      error: `${BUNDLE_SETTING_LABELS.builders} (bundleBuilders) must be a list of up to ${MAX_SELECTED_BUILDERS} builder names, with no templates.`,
    };
  }
  const ahead = readSendAhead(input, blocks, phase);
  if (!ahead.ok) {
    return ahead;
  }
  return {
    ok: true,
    settings: {
      blocks,
      tipIncreasePercent,
      ...(builders && { builders }),
      ...(ahead.sendAhead && { sendAhead: ahead.sendAhead }),
      ...(ahead.refusal && { notBeforeRefusal: ahead.refusal }),
    },
  };
}

const NOT_BEFORE_NAME = `${BUNDLE_SETTING_LABELS.notBefore} (notBefore)`;
const SEND_AHEAD_NAME = `${BUNDLE_SETTING_LABELS.sendAheadBlocks} (sendAheadBlocks)`;

type SendAheadRead =
  | { ok: true; sendAhead?: SendAhead; refusal?: string }
  | { ok: false; error: string; field: string };

/** A Not before that cannot be used: a save error, or data at run so a replay still returns its result. */
function notBeforeRefused(error: string, phase: SettingsPhase): SendAheadRead {
  return phase === "run"
    ? { ok: true, refusal: error }
    : { ok: false, field: BUNDLE_SETTING_KEYS.notBefore, error };
}

/** A resolved Not before outside MIN..MAX_UNIX_SECONDS, as a run refusal; else undefined. */
function runRangeRefusal(seconds: number, raw: unknown): string | undefined {
  if (seconds >= MIN_UNIX_SECONDS && seconds <= MAX_UNIX_SECONDS) {
    return;
  }
  // A date, not a number: only the range is worth saying.
  const text = String(raw).trim();
  if (typeof raw === "string" && !INTEGER_RE.test(text)) {
    return `${NOT_BEFORE_NAME} resolved to ${shortened(text)}, which is before 2001-09-09 or after 2286-11-20, so nothing was sent.`;
  }
  const shown = Number.isSafeInteger(seconds) ? seconds : shortened(text);
  if (seconds === 0) {
    return `${NOT_BEFORE_NAME} resolved to 0, which usually means the time is not set yet, so nothing was sent.`;
  }
  if (seconds < MIN_UNIX_SECONDS) {
    return `${NOT_BEFORE_NAME} resolved to ${shown}, which looks like a duration or block number, not a unix time, so nothing was sent.`;
  }
  return `${NOT_BEFORE_NAME} resolved to ${shown}, which is past the year 2286 and is not a unix time (an amount, or a 'never' value such as the largest uint256), so nothing was sent.`;
}

/** Not before and Send ahead; Send ahead is range-checked always, used only with Not before. */
function readSendAhead(
  input: BundleSettingsInput,
  blocks: number,
  phase: SettingsPhase
): SendAheadRead {
  const aheadBlocks = isUnset(input.sendAheadBlocks)
    ? DEFAULT_SEND_AHEAD_BLOCKS
    : readInteger(input.sendAheadBlocks, {
        min: 0,
        max: MAX_SEND_AHEAD_BLOCKS,
      });
  if (aheadBlocks === undefined) {
    return {
      ok: false,
      field: BUNDLE_SETTING_KEYS.sendAheadBlocks,
      error: `${SEND_AHEAD_NAME} must be a whole number from 0 to ${MAX_SEND_AHEAD_BLOCKS}, with no templates, not ${quoted(input.sendAheadBlocks)}.`,
    };
  }
  if (isUnset(input.notBefore)) {
    // A template that resolved empty must not turn the gate off.
    if (phase === "run" && input[NOT_BEFORE_FROM_TEMPLATE_KEY] === true) {
      return notBeforeRefused(
        `${NOT_BEFORE_NAME} resolved to an empty value, so nothing was sent.`,
        phase
      );
    }
    return { ok: true };
  }
  if (aheadBlocks + blocks > MAX_BUNDLE_BLOCKS) {
    return {
      ok: false,
      field: BUNDLE_SETTING_KEYS.sendAheadBlocks,
      error: `Send ahead (${aheadBlocks}) + ${BUNDLE_SETTING_LABELS.blocks} (${blocks}) is ${aheadBlocks + blocks}. Together they can be at most ${MAX_BUNDLE_BLOCKS}, so lower one of them (sendAheadBlocks, bundleBlocks).`,
    };
  }
  const templated =
    typeof input.notBefore === "string" &&
    input.notBefore.includes(TEMPLATE_MARK);
  if (templated && phase === "save") {
    return { ok: true };
  }
  if (templated) {
    return notBeforeRefused(
      `${NOT_BEFORE_NAME} still holds a template after it was filled in, so nothing was sent: ${quoted(input.notBefore)}.`,
      phase
    );
  }
  // A save keeps to the range with one message; a run names what an out-of-range value looks like.
  const time = readUnixTime(input.notBefore, { strict: phase === "save" });
  if (!time.ok) {
    return notBeforeRefused(
      `${NOT_BEFORE_NAME} ${quoted(input.notBefore)}: ${time.reason}${phase === "run" ? " Nothing was sent." : ""}`,
      phase
    );
  }
  const outOfRange =
    phase === "run"
      ? runRangeRefusal(time.seconds, input.notBefore)
      : undefined;
  if (outOfRange) {
    return notBeforeRefused(outOfRange, phase);
  }
  return {
    ok: true,
    sendAhead: { notBefore: time.seconds, blocks: aheadBlocks },
  };
}
