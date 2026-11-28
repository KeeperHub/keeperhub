type Rollout =
  | { kind: "off" }
  | { kind: "all" }
  | { kind: "orgs"; ids: string[] }
  | { kind: "percent"; percent: number };

// Digits with an optional fraction: no hex, exponent or inner spaces.
const PERCENT_RE = /^\d+(\.\d+)?$/;

/** off | all | orgs:<id>,<id> | percent:<n>; anything else is off. */
function parseRollout(rollout: string | undefined): Rollout {
  const value = rollout?.trim() ?? "";
  if (value === "all") {
    return { kind: "all" };
  }
  if (value.startsWith("orgs:")) {
    const ids = value
      .slice("orgs:".length)
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    return ids.length > 0 ? { kind: "orgs", ids } : { kind: "off" };
  }
  if (value.startsWith("percent:")) {
    const text = value.slice("percent:".length);
    const percent = PERCENT_RE.test(text) ? Number(text) : 0;
    return percent > 0 ? { kind: "percent", percent } : { kind: "off" };
  }
  return { kind: "off" };
}

/** Per-org rollout setting: off | all | orgs:<id>,<id> | percent:<n> (hashed, so raising n only adds). */
export function isEnabledForOrg(
  organizationId: string,
  rollout: string | undefined
): boolean {
  const parsed = parseRollout(rollout);
  switch (parsed.kind) {
    case "all":
      return true;
    case "orgs":
      return parsed.ids.includes(organizationId);
    case "percent":
      return orgBucket(organizationId) < Math.min(parsed.percent, 100);
    default:
      return false;
  }
}

/** Rows of orgs in the rollout, and the rest (no org counts as outside). */
export function splitByRollout<T>(
  rows: T[],
  orgOf: (row: T) => string | undefined,
  rollout: string | undefined
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const row of rows) {
    const org = orgOf(row);
    if (org !== undefined && isEnabledForOrg(org, rollout)) {
      kept.push(row);
    } else {
      dropped.push(row);
    }
  }
  return { kept, dropped };
}

/** Whether any organization can be in the rollout; agrees with isEnabledForOrg. */
export function isRolloutActive(rollout: string | undefined): boolean {
  return parseRollout(rollout).kind !== "off";
}

/** 0-99, stable per organization (FNV-1a: spreads ids evenly, no secrecy needed). */
function orgBucket(organizationId: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < organizationId.length; i += 1) {
    hash ^= organizationId.charCodeAt(i);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return (hash >>> 0) % 100;
}
