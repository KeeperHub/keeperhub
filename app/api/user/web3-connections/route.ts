import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { safeWallets } from "@/lib/db/schema";
import { resolveOrganizationId } from "@/lib/middleware/auth-helpers";
import { resolveSignerMode } from "@/lib/safe/signer-resolver";

/**
 * Web3 Connection picker options for a single (org, chain) pair.
 *
 * Returned to `Web3ConnectionSelect` so the picker can:
 *   - Label the "Default (Safe)" / "Default (EOA)" choice without re-running
 *     the resolver client-side.
 *   - Decide when to show the "selecting EOA bypasses the org Safe" warning
 *     (defaultKind === "safe" and the user picks "eoa").
 *   - List per-chain Safes that are deployed AND signing-active. Pending
 *     Safes and signing-off Safes are intentionally excluded. A node
 *     pinned to a pending Safe would fail at execution time anyway.
 *
 * `chainId` query param is required for chain-aware filtering. Workflow
 * nodes whose network is templated (`{{trigger.chainId}}`) call without a
 * chain and get only the "default" + "eoa" options.
 */
type Web3ConnectionOption =
  | { value: "default"; label: string; kind: "default" }
  | { value: "eoa"; label: string; kind: "eoa" }
  | {
      value: `safe:${string}`;
      label: string;
      kind: "safe";
      safeAddress: string;
    };

type Web3ConnectionsResponse = {
  defaultKind: "eoa" | "safe";
  options: Web3ConnectionOption[];
};

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await resolveOrganizationId(request);
    if ("error" in ctx) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }

    const url = new URL(request.url);
    const chainIdParam = url.searchParams.get("chainId");
    const chainId = chainIdParam ? Number(chainIdParam) : Number.NaN;
    const hasChain = Number.isInteger(chainId) && chainId > 0;

    const options: Web3ConnectionOption[] = [];

    if (!hasChain) {
      // No chain pinned (templated network). Only Default + EOA are sensible
      // here; specific Safes are chain-bound and can't be validated up-front.
      options.push({
        value: "default",
        label: "Default",
        kind: "default",
      });
      options.push({ value: "eoa", label: "EOA", kind: "eoa" });
      const body: Web3ConnectionsResponse = {
        defaultKind: "eoa",
        options,
      };
      return NextResponse.json(body);
    }

    const [defaultMode, safes] = await Promise.all([
      resolveSignerMode(ctx.organizationId, chainId),
      db
        .select({
          id: safeWallets.id,
          safeAddress: safeWallets.safeAddress,
        })
        .from(safeWallets)
        .where(
          and(
            eq(safeWallets.organizationId, ctx.organizationId),
            eq(safeWallets.chainId, chainId),
            eq(safeWallets.status, "deployed"),
            eq(safeWallets.isSigningActive, true)
          )
        ),
    ]);

    const defaultKind: "eoa" | "safe" =
      defaultMode.kind === "eoa" ? "eoa" : "safe";
    const defaultLabel =
      defaultKind === "safe" ? "Default (Safe)" : "Default (EOA)";

    options.push({ value: "default", label: defaultLabel, kind: "default" });
    options.push({ value: "eoa", label: "EOA", kind: "eoa" });
    for (const safe of safes) {
      options.push({
        value: `safe:${safe.id}`,
        label: `Safe ${truncateAddress(safe.safeAddress)}`,
        kind: "safe",
        safeAddress: safe.safeAddress,
      });
    }

    const body: Web3ConnectionsResponse = {
      defaultKind,
      options,
    };
    return NextResponse.json(body);
  } catch (error) {
    return apiError(error, "Failed to list web3 connections");
  }
}

function truncateAddress(address: string): string {
  if (address.length <= 10) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
