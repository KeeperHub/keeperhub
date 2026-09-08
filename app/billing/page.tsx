import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { getActiveOrgId } from "@/lib/middleware/org-context";

/**
 * Billing lives in settings now. This route stays because links to it are
 * already out in the world, in emails and in the app, and sends them on.
 */
export default async function BillingRoute(): Promise<never> {
  if (!isBillingEnabled()) {
    notFound();
  }

  const hdrs = await headers();
  const session = await auth.api.getSession({ headers: hdrs });
  if (!session?.user) {
    redirect("/?returnTo=%2Fbilling");
  }

  const orgId = getActiveOrgId(session);
  redirect(orgId ? `/settings/${orgId}/billing` : "/settings");
}
