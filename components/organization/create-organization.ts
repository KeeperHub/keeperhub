import { holdOrgSwitching } from "@/components/organization/org-switch-runner";
import { authClient } from "@/lib/auth-client";

/**
 * Creates an organization, which the auth server makes the active one (and
 * the auth client then reloads), under the switch lock, so no switcher
 * switches meanwhile. Shared by the manage organizations dialog and the
 * settings page.
 */
export function createOrganization(input: {
  name: string;
  slug: string;
}): ReturnType<typeof authClient.organization.create> {
  return holdOrgSwitching(() => authClient.organization.create(input));
}
