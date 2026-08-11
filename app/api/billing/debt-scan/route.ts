import { NextResponse } from "next/server";
import { scanAndCreateDebt } from "@/lib/billing/execution-debt";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";

/**
 * Internal POST endpoint for scanning unpaid overage and creating debt records.
 * Called by the scheduler daily after the 15-day grace period.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  try {
    const result = await scanAndCreateDebt();
    return NextResponse.json(result);
  } catch (error) {
    logSystemError(ErrorCategory.DATABASE, "[Billing] Debt scan error", error, {
      endpoint: "/api/billing/debt-scan",
      operation: "post",
    });
    return NextResponse.json({ error: "Debt scan failed" }, { status: 500 });
  }
}
