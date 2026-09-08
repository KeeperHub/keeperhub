import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import { listPaygPaymentsPage } from "@/lib/billing/payg/payments";
import { usdcRawToDecimal } from "@/lib/billing/payg/usdc";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  type OrganizationAuthContext,
  resolveOrganizationId,
} from "@/lib/middleware/auth-helpers";
import { buildPage, parsePageRequest } from "@/lib/pagination";
import { buildChainTransactionUrl } from "@/lib/web3/chain-adapter/explorer";

export type PaygChargeItem = {
  executionId: string;
  workflowId: string | null;
  workflowName: string | null;
  amountUsdc: string;
  txHash: string | null;
  txUrl: string | null;
  chainId: number;
  createdAt: string;
};

/**
 * Server-side paginated list of an org's PAYG charges, newest first. Each row
 * carries the workflow it was charged for (null for direct-API charges) and a
 * block-explorer link for its settlement tx.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!isBillingEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let authContext: OrganizationAuthContext | null = null;
  try {
    authContext = await resolveOrganizationId(request);
    if ("error" in authContext) {
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const url = new URL(request.url);
    const req = parsePageRequest(url, { fallback: 10, max: 100 });
    const search = url.searchParams.get("q")?.slice(0, 200) ?? undefined;
    const { items, total } = await listPaygPaymentsPage(
      authContext.organizationId,
      { limit: req.pageSize, offset: req.offset, search }
    );

    const charges: PaygChargeItem[] = await Promise.all(
      items.map(async (row) => {
        const rawUrl = row.txHash
          ? await buildChainTransactionUrl(row.chainId, row.txHash)
          : "";
        return {
          executionId: row.executionId,
          workflowId: row.workflowId,
          workflowName: row.workflowName,
          amountUsdc: usdcRawToDecimal(BigInt(row.amountRaw)),
          txHash: row.txHash,
          txUrl: rawUrl.length > 0 ? rawUrl : null,
          chainId: row.chainId,
          createdAt: row.createdAt.toISOString(),
        };
      })
    );

    return NextResponse.json(buildPage(charges, total, req, url));
  } catch (error) {
    logSystemError(ErrorCategory.BILLING, "[PAYG] Charges error", error, {
      endpoint: "/api/billing/payg/charges",
      operation: "get",
    });
    return NextResponse.json(
      { error: "Failed to load pay-as-you-go charges" },
      { status: 500 }
    );
  }
}
