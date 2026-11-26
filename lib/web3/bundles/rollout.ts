import { logWarn } from "@/lib/logging";
import { isEnabledForOrg } from "@/lib/rollout";

let warnedPercent = false;

function isPercent(rollout: string | undefined): boolean {
  if (!rollout?.trim().startsWith("percent:")) {
    return false;
  }
  if (!warnedPercent) {
    warnedPercent = true;
    logWarn(
      "[Bundle] BUNDLE_SEND_ROLLOUT takes off, all or orgs:<ids>; a percent turns it off"
    );
  }
  return true;
}

/**
 * BUNDLE_SEND_ROLLOUT: off | all | orgs:<ids> (off by default). A percent is
 * refused: anyone can create organizations until one lands in the bucket.
 */
export function isBundleSendEnabledForOrg(
  organizationId: string,
  rollout: string | undefined = process.env.BUNDLE_SEND_ROLLOUT
): boolean {
  return !isPercent(rollout) && isEnabledForOrg(organizationId, rollout);
}
