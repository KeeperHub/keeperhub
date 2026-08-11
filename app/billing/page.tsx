import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { BillingPage } from "@/components/billing/billing-page";
import { auth } from "@/lib/auth";
import { isBillingEnabled } from "@/lib/billing/feature-flag";

export default async function BillingRoute(): Promise<React.ReactElement> {
  if (!isBillingEnabled()) {
    notFound();
  }

  const hdrs = await headers();
  const session = await auth.api.getSession({ headers: hdrs });
  if (!session?.user) {
    redirect("/?returnTo=%2Fbilling");
  }

  const activeMember = await auth.api.getActiveMember({ headers: hdrs });
  if (activeMember?.role !== "owner") {
    redirect("/");
  }

  return (
    <Suspense>
      <BillingPage />
    </Suspense>
  );
}
