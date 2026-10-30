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

/** 0-99, stable per organization (FNV-1a: spreads ids evenly, no secrecy needed). */
function orgBucket(organizationId: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < organizationId.length; i += 1) {
    hash ^= organizationId.charCodeAt(i);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return (hash >>> 0) % 100;
}
