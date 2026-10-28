import { createHash } from "node:crypto";

/** FAILURE_ALERTS_ROLLOUT: off | all | orgs:<id>,<id> | percent:<n> (hashed, so raising n only adds). */
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
