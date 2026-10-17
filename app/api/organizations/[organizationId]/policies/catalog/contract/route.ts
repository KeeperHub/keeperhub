import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { isValidAddress } from "@/lib/policy";
import {
  AMBIENT_CONDITION_KEYS,
  RISK_CLASS_LABEL,
  RISK_CLASS_ORDER,
} from "@/lib/policy/catalog";
import { getContractCatalog } from "@/lib/policy/catalog/store";
import type { SelectorCatalogEntry } from "@/lib/policy/catalog/types";
import { getNetworkName } from "@/lib/rpc/network-utils";
import { requireOrgPolicyAccess } from "../../_lib/access";

type RiskGroup = {
  riskClass: string;
  label: string;
  entries: SelectorCatalogEntry[];
};

/** Groups entries in risk order so the picker leads with what is dangerous. */
function groupByRiskClass(
  entries: readonly SelectorCatalogEntry[]
): RiskGroup[] {
  const groups: RiskGroup[] = [];
  for (const riskClass of RISK_CLASS_ORDER) {
    const matching = entries.filter((entry) => entry.riskClass === riskClass);
    if (matching.length > 0) {
      groups.push({
        riskClass,
        label: RISK_CLASS_LABEL[riskClass],
        entries: matching,
      });
    }
  }
  return groups;
}

/**
 * The selector catalog for one contract.
 *
 * The address in the response is the one a rule must pin, which for an
 * upgradeable protocol is the proxy: it is what appears as `to` on the wire.
 * The functions come from the implementation ABI, reported separately, because
 * a rule pinned to the implementation would silently match nothing.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ organizationId: string }> }
): Promise<Response> {
  const { organizationId } = await context.params;
  const access = await requireOrgPolicyAccess(request, organizationId, "read");
  if (!access.ok) {
    return access.response;
  }

  const url = new URL(request.url);
  const address = url.searchParams.get("address");
  const chainIdParam = url.searchParams.get("chainId");
  const protocolSlug = url.searchParams.get("protocolSlug") ?? undefined;

  if (!(address && isValidAddress(address))) {
    return NextResponse.json(
      { error: "A valid contract address is required" },
      { status: 400 }
    );
  }

  const chainId = Number(chainIdParam);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return NextResponse.json(
      { error: "A valid chainId is required" },
      { status: 400 }
    );
  }

  let catalog: Awaited<ReturnType<typeof getContractCatalog>>;
  try {
    catalog = await getContractCatalog({
      chainId,
      address,
      network: getNetworkName(chainId),
      protocolSlug,
    });
  } catch (error) {
    return apiError(error, "Failed to read the contract catalog");
  }

  const writes = catalog.entries.filter(
    (entry) =>
      entry.stateMutability !== "view" && entry.stateMutability !== "pure"
  );

  return NextResponse.json({
    chainId: catalog.chainId,
    address: catalog.address,
    implementationAddress: catalog.implementationAddress,
    isProxy: catalog.implementationAddress !== null,
    /** Empty when the contract is unverified. Not an error. */
    verified: catalog.entries.length > 0,
    collisions: catalog.collisions,
    dispatchers: writes
      .filter((entry) => entry.isDispatcher)
      .map((e) => e.selector),
    ambientConditionKeys: AMBIENT_CONDITION_KEYS,
    groups: groupByRiskClass(writes),
    readCount: catalog.entries.length - writes.length,
  });
}
