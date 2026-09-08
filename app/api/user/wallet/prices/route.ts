import { NextResponse } from "next/server";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { fetchAssetPrices, type PriceRequest } from "@/lib/wallet/asset-prices";

type Body = {
  assets?: { chainId?: unknown; tokenAddress?: unknown }[];
};

function parse(body: Body): PriceRequest[] {
  const requests: PriceRequest[] = [];
  for (const asset of body.assets ?? []) {
    if (typeof asset?.chainId !== "number") {
      continue;
    }
    requests.push({
      chainId: asset.chainId,
      tokenAddress:
        typeof asset.tokenAddress === "string" ? asset.tokenAddress : undefined,
    });
  }
  return requests;
}

/**
 * POST /api/user/wallet/prices
 *
 * USD prices for the assets a wallet holds, so the client can total them up
 * without learning where the prices come from. Assets that cannot be priced
 * are simply absent from the response.
 */
export async function POST(request: Request): Promise<Response> {
  const authCtx = await resolveOrganizationId(request);
  if ("error" in authCtx) {
    return NextResponse.json(
      { error: authCtx.error },
      { status: authCtx.status }
    );
  }

  try {
    const body = (await request.json()) as Body;
    const prices = await fetchAssetPrices(parse(body));
    return NextResponse.json({ prices });
  } catch (error) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[WalletPrices] Could not resolve asset prices",
      error,
      { endpoint: "/api/user/wallet/prices" }
    );
    return NextResponse.json({ prices: {} });
  }
}
