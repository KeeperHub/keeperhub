/** Most blocks a bundle step may target; each adds about 12 s while the wallet is held. */
const MAX_BUNDLE_BLOCKS = 5;
const DEFAULT_BUNDLE_BLOCKS = 3;
const MAX_TIP_INCREASE_PERCENT = 100;
const MAX_SELECTED_BUILDERS = 16;

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

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

// A whole number in range, from a number or its decimal text.
function readInteger(
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

function readBuilderNames(value: unknown): string[] | undefined | null {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list) || list.length > MAX_SELECTED_BUILDERS) {
    return null;
  }
  const names: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return null;
    }
    names.push(entry.trim());
  }
  // An empty list means every builder, as an absent one does.
  return names.length === 0 ? undefined : [...new Set(names)];
}

/** The step's bundle settings with their defaults, or the reason one is wrong. */
export function readBundleSettings(
  input: BundleSettingsInput
): { ok: true; settings: BundleSettings } | { ok: false; error: string } {
  const blocks = isUnset(input.bundleBlocks)
    ? DEFAULT_BUNDLE_BLOCKS
    : readInteger(input.bundleBlocks, { min: 1, max: MAX_BUNDLE_BLOCKS });
  if (blocks === undefined) {
    return {
      ok: false,
      error: `bundleBlocks must be a whole number from 1 to ${MAX_BUNDLE_BLOCKS}, not ${JSON.stringify(input.bundleBlocks)}.`,
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
      error: `bundleTipIncreasePercent must be a whole number from 0 to ${MAX_TIP_INCREASE_PERCENT}, not ${JSON.stringify(input.bundleTipIncreasePercent)}.`,
    };
  }
  const builders = isUnset(input.bundleBuilders)
    ? undefined
    : readBuilderNames(input.bundleBuilders);
  if (builders === null) {
    return {
      ok: false,
      error: `bundleBuilders must be a list of up to ${MAX_SELECTED_BUILDERS} builder names.`,
    };
  }
  return {
    ok: true,
    settings: { blocks, tipIncreasePercent, ...(builders && { builders }) },
  };
}
