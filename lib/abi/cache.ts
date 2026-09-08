import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import {
  fetchEtherscanAbi,
  fetchEtherscanSourceCode,
} from "@/lib/explorer/etherscan";
import { detectProxyViaRpc } from "@/lib/explorer/proxy-detection";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";

type AbiCacheEntry = {
  abi: string;
  fetchedAt: number;
};

type ResolveAbiInput = {
  contractAddress: string;
  network: string;
  abi?: string;
};

type ResolveAbiResult = {
  abi: string;
  source: "definition" | "cache" | "explorer";
};

const abiCache = new Map<string, AbiCacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";

function buildCacheKey(chainId: number, contractAddress: string): string {
  return `${chainId}:${contractAddress.toLowerCase()}`;
}

async function fetchAbiFromExplorer(
  chainId: number,
  contractAddress: string
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

  const proxyResult = await detectProxyViaRpc(contractAddress, chainId);
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
  const cacheKey = buildCacheKey(chainId, input.contractAddress);

  const cached = abiCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { abi: cached.abi, source: "cache" };
  }

  const abi = await fetchAbiFromExplorer(chainId, input.contractAddress);
  abiCache.set(cacheKey, { abi, fetchedAt: Date.now() });

  return { abi, source: "explorer" };
}
