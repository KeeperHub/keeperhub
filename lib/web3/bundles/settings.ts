/** Most blocks a bundle step may target; each adds about 12 s while the wallet is held. */
export const MAX_BUNDLE_BLOCKS = 5;
export const DEFAULT_BUNDLE_BLOCKS = 3;
export const MAX_TIP_INCREASE_PERCENT = 100;
export const MAX_SELECTED_BUILDERS = 16;

/** The config keys of a bundle step's settings. */
export const BUNDLE_SETTING_KEYS = {
  blocks: "bundleBlocks",
  tipIncreasePercent: "bundleTipIncreasePercent",
  builders: "bundleBuilders",
} as const;

/** The editor labels of those keys, so errors name both. */
export const BUNDLE_SETTING_LABELS = {
  blocks: "Target blocks",
  tipIncreasePercent: "Tip increase per block (%)",
  builders: "Builders",
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

/** A bundle step's settings, as it sends them. */
export type BundleSettings = {
  blocks: number;
  tipIncreasePercent: number;
  // Builder names; undefined means every builder of the network.
  builders?: string[];
};

export type BundleSettingsInput = {
  bundleBlocks?: unknown;
  bundleTipIncreasePercent?: unknown;
  bundleBuilders?: unknown;
};

const INTEGER_RE = /^\d+$/;
const TEMPLATE_MARK = "{{";
// Longest value an error quotes back.
const MAX_QUOTED_CHARS = 40;

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

/** The step's bundle settings with their defaults, or the reason one is wrong. */
export function readBundleSettings(
  input: BundleSettingsInput
):
  | { ok: true; settings: BundleSettings }
  | { ok: false; error: string; field: string } {
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
  return {
    ok: true,
    settings: { blocks, tipIncreasePercent, ...(builders && { builders }) },
  };
}
