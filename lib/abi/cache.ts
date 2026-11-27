import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import {
  fetchEtherscanAbi,
  fetchEtherscanSourceCode,
} from "@/lib/explorer/etherscan";
import { detectProxyViaRpc } from "@/lib/explorer/proxy-detection";
import {
  ownEndpointsScope,
  PlatformRpcPurpose,
  platformScope,
  type RpcScope,
  RpcScopeKind,
} from "@/lib/rpc/engine";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { DAY_MS } from "@/lib/utils/duration";

type AbiCacheEntry = {
  abi: string;
  fetchedAt: number;
};

type ResolveAbiInput = {
  contractAddress: string;
  network: string;
  abi?: string;
  /** Who the lookup is for; decides which endpoints the proxy probe uses. */
  rpcScope?: RpcScope;
};

// The resolved ABI is cached for every organization, so the proxy probe that
// picks it must not take any one organization's endpoint's word for it.
const SHARED_ABI_SCOPE = platformScope(PlatformRpcPurpose.SHARED_CACHE);

type AbiLookup = {
  /** Where the proxy probe runs. */
  probeScope: RpcScope;
  /** Prefix that keeps an organization's own result out of the shared cache. */
  cachePrefix: string;
};

const SHARED_LOOKUP: AbiLookup = {
  probeScope: SHARED_ABI_SCOPE,
  cachePrefix: "",
};

/**
 * A chain on which the organization uses its own endpoints only is probed on
 * those endpoints and cached for that organization alone; everything else
 * shares one probe on KeeperHub's endpoints.
 */
async function abiLookupFor(
  scope: RpcScope | undefined,
  chainId: number
): Promise<AbiLookup> {
  const own = await ownEndpointsScope(scope, chainId);
  return own?.kind === RpcScopeKind.ORG
    ? { probeScope: own, cachePrefix: `${own.organizationId}:` }
    : SHARED_LOOKUP;
}

type ResolveAbiResult = {
  abi: string;
  source: "definition" | "cache" | "explorer";
};

const abiCache = new Map<string, AbiCacheEntry>();
const CACHE_TTL_MS = DAY_MS;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";

function buildCacheKey(chainId: number, contractAddress: string): string {
  return `${chainId}:${contractAddress.toLowerCase()}`;
}

async function fetchAbiFromExplorer(
  chainId: number,
  contractAddress: string,
  probeScope: RpcScope
): Promise<string> {
  const explorerResults = await db
    .select()
    .from(explorerConfigs)
    .where(eq(explorerConfigs.chainId, chainId))
    .limit(1);

  const explorer = explorerResults[0];
  if (!explorer?.explorerApiUrl) {
    throw new Error(`No explorer API configured for chain ${chainId}`);
  }

  const [directResult, sourceCodeResult] = await Promise.all([
    fetchEtherscanAbi(
      explorer.explorerApiUrl,
      chainId,
      contractAddress,
      ETHERSCAN_API_KEY
    ),
    fetchEtherscanSourceCode(
      explorer.explorerApiUrl,
      chainId,
      contractAddress,
      ETHERSCAN_API_KEY
    ),
  ]);

  if (
    sourceCodeResult.success &&
    sourceCodeResult.isProxy &&
    sourceCodeResult.implementationAddress
  ) {
    const implResult = await fetchEtherscanAbi(
      explorer.explorerApiUrl,
      chainId,
      sourceCodeResult.implementationAddress,
      ETHERSCAN_API_KEY
    );
    if (implResult.success && implResult.abi) {
      return JSON.stringify(implResult.abi);
    }
  }

  if (directResult.success && directResult.abi) {
    const hasFunctions = directResult.abi.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).type === "function"
    );
    if (hasFunctions) {
      return JSON.stringify(directResult.abi);
    }
  }

  const proxyResult = await detectProxyViaRpc(
    contractAddress,
    chainId,
    probeScope
  );
  if (proxyResult.isProxy && proxyResult.implementationAddress) {
    const implResult = await fetchEtherscanAbi(
      explorer.explorerApiUrl,
      chainId,
      proxyResult.implementationAddress,
      ETHERSCAN_API_KEY
    );
    if (implResult.success && implResult.abi) {
      return JSON.stringify(implResult.abi);
    }
  }

  throw new Error(
    `Unable to fetch ABI for ${contractAddress} on chain ${chainId}. Contract may not be verified.`
  );
}

export async function resolveAbi(
  input: ResolveAbiInput
): Promise<ResolveAbiResult> {
  if (input.abi) {
    return { abi: input.abi, source: "definition" };
  }

  const chainId = getChainIdFromNetwork(input.network);
  const lookup = await abiLookupFor(input.rpcScope, chainId);
  const cacheKey = `${lookup.cachePrefix}${buildCacheKey(chainId, input.contractAddress)}`;

  const cached = abiCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { abi: cached.abi, source: "cache" };
  }

  const abi = await fetchAbiFromExplorer(
    chainId,
    input.contractAddress,
    lookup.probeScope
  );
  abiCache.set(cacheKey, { abi, fetchedAt: Date.now() });

  return { abi, source: "explorer" };
}
