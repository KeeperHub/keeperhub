import { createHash } from "node:crypto";

/**
 * Which organizations have workflow failure notifications switched on.
 *
 * Read from FAILURE_ALERTS_ROLLOUT so the launch can go out in waves and be
 * switched off without a deploy of new code:
 *
 * - unset or "off": nobody
 * - "all": everybody
 * - "orgs:<id>,<id>": only these organizations (internal ones first)
 * - "percent:<n>": a stable n% of organizations, plus nothing else
 *
 * The bucket for "percent" is a hash of the organization id, so raising the
 * number only ever adds organizations and never flips one back off.
 */
export function isFailureAlertsEnabledForOrg(
  organizationId: string,
  rollout: string | undefined = process.env.FAILURE_ALERTS_ROLLOUT
): boolean {
  const value = rollout?.trim() ?? "";
  if (value === "" || value === "off") {
    return false;
  }
  if (value === "all") {
    return true;
  }
  if (value.startsWith("orgs:")) {
    const ids = value
      .slice("orgs:".length)
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    return ids.includes(organizationId);
  }
  if (value.startsWith("percent:")) {
    const percent = Number(value.slice("percent:".length));
    if (!Number.isFinite(percent) || percent <= 0) {
      return false;
    }
    return orgBucket(organizationId) < Math.min(percent, 100);
  }
  return false;
}

export function isFailureAlertsRolloutActive(
  rollout: string | undefined = process.env.FAILURE_ALERTS_ROLLOUT
): boolean {
  const value = rollout?.trim() ?? "";
  return value !== "" && value !== "off";
}

/** 0-99, stable per organization. */
function orgBucket(organizationId: string): number {
  const digest = createHash("sha256").update(organizationId).digest();
  return digest.readUInt32BE(0) % 100;
}
