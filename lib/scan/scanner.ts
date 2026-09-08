import "server-only";

import { and, eq, gt } from "drizzle-orm";
import { ethers } from "ethers";
import {
  normalizeAddressForStorage,
  toChecksumAddress,
} from "@/lib/address-utils";
import { db } from "@/lib/db";
import { supportedTokens } from "@/lib/db/schema";
import { scanResults } from "@/lib/db/schema-scan";
import { getMetricsCollector } from "@/lib/metrics";
import { recordScanCacheLookup } from "@/lib/metrics/collectors/prometheus";
import { MetricNames } from "@/lib/metrics/types";
import { getEnabledChains } from "@/lib/rpc/chain-service";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import {
  buildAaveV3Calls,
  decodeAaveV3Results,
} from "@/lib/scan/adapters/aave-v3";
import { buildLidoCalls, decodeLidoResults } from "@/lib/scan/adapters/lido";
import {
  SKY_SAVINGS,
  STABLECOIN_CHAINLINK_FEEDS,
  scannableChainIds,
} from "@/lib/scan/adapters/protocol-registry";
import { buildSkyCalls, decodeSkyResults } from "@/lib/scan/adapters/sky";
import { buildSparkCalls, decodeSparkResults } from "@/lib/scan/adapters/spark";
import {
  buildStablecoinCalls,
  decodeStablecoinResults,
  type StablecoinToken,
} from "@/lib/scan/adapters/stablecoins";
import { executeMulticallBatch } from "@/lib/scan/multicall-batch";
import { isDepegged, readChainlinkPrice } from "@/lib/scan/price/chainlink";
import { resolveUsdPrice } from "@/lib/scan/price/index";
import { scanChains } from "@/lib/scan/scan-chains";
import {
  type AdapterCallDescriptor,
  type ChainScanOutput,
  type MulticallResult,
  type ProtocolPosition,
  SCAN_SCHEMA_VERSION,
  type ScanResponse,
  type StablecoinBalance,
} from "@/lib/scan/types";
import { maybeZerionFallback } from "@/lib/scan/zerion-fallback";

/** Cache TTL in milliseconds — 5 minutes (SCAN-13). */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Stablecoin symbols excluded from scan coverage (scan-path-local only).
 *
 * Tokens in this set are filtered from the chainStablecoins list after the
 * DB query and before buildStablecoinCalls and the Chainlink loop. The global
 * supported_tokens registry and workflow builder token pickers are unaffected.
 *
 * DAI is excluded in favour of USDS / sUSDS (Sky Protocol successor token).
 */
export const SCAN_EXCLUDED_STABLECOINS = new Set(["DAI"]);

// ─── Internal: single-chain scan ─────────────────────────────────────────────

/**
 * Scan one EVM chain for the target address.
 *
 * Concatenates Aave V3, Lido, Spark, Sky, stablecoin, and Chainlink Multicall3
 * call descriptors into a single `aggregate3.staticCall`, then decodes results
 * per-adapter in the consistent order [aave, lido, spark, sky, stablecoin,
 * chainlink]. Stablecoin USD prices are resolved via Chainlink (when a feed is
 * registered for the chain) or DefiLlama HTTP fallback, and depeg status is
 * flagged. Sky positions are priced by decoding the maxWithdraw (USDS
 * underlying) result and resolving the USDS USD price via resolveUsdPrice.
 * DAI is excluded from scanned stablecoins via SCAN_EXCLUDED_STABLECOINS.
 * Never throws — let the `scanChains` fan-out caller handle errors (per-chain
 * isolation).
 */
async function scanOneChain(
  chainId: number,
  userAddress: string
): Promise<ChainScanOutput> {
  const rpcManager = await getRpcProvider({ chainId });

  // Stablecoins registered for this chain (isStablecoin = true).
  const rawChainStablecoins: StablecoinToken[] = await db
    .select({
      tokenAddress: supportedTokens.tokenAddress,
      symbol: supportedTokens.symbol,
      decimals: supportedTokens.decimals,
    })
    .from(supportedTokens)
    .where(
      and(
        eq(supportedTokens.chainId, chainId),
        eq(supportedTokens.isStablecoin, true)
      )
    );

  // Apply scan-local exclusion before buildStablecoinCalls and the Chainlink
  // loop so DAI neither generates a balance call nor a Chainlink feed call.
  const chainStablecoins = rawChainStablecoins.filter(
    (t) => !SCAN_EXCLUDED_STABLECOINS.has(t.symbol)
  );

  // ── Build calls ─────────────────────────────────────────────────────────────
  const aaveCalls = buildAaveV3Calls(userAddress, chainId);
  const lidoCalls = buildLidoCalls(userAddress, chainId);
  const sparkCalls = buildSparkCalls(userAddress, chainId);
  const skyCalls = buildSkyCalls(userAddress, chainId);
  const stablecoinCalls = buildStablecoinCalls(userAddress, chainStablecoins);

  // One Chainlink latestRoundData call per stablecoin that has a registered
  // feed on this chain. Track which stablecoin indices have feeds so results
  // can be paired back after decoding.
  const chainlinkCallDescriptors: AdapterCallDescriptor[] = [];
  const chainlinkFeedIndices: number[] = [];
  for (const [idx, token] of chainStablecoins.entries()) {
    const feedAddress = STABLECOIN_CHAINLINK_FEEDS[chainId]?.[token.symbol];
    if (feedAddress !== undefined) {
      chainlinkCallDescriptors.push(readChainlinkPrice(feedAddress));
      chainlinkFeedIndices.push(idx);
    }
  }

  // Consistent batch order: [aave, lido, spark, sky, stablecoin, chainlink].
  // The slice math below must match this order exactly (T-56-02 guard).
  const allCalls = [
    ...aaveCalls,
    ...lidoCalls,
    ...sparkCalls,
    ...skyCalls,
    ...stablecoinCalls,
    ...chainlinkCallDescriptors,
  ];

  // If there's nothing to scan on this chain, return empty output immediately.
  if (allCalls.length === 0) {
    return { chainId, positions: [], stablecoins: [] };
  }

  const results: MulticallResult[] = await executeMulticallBatch(
    allCalls,
    rpcManager
  );

  // ── Slice results per adapter (must match build order above) ───────────────
  const aaveLen = aaveCalls.length;
  const lidoLen = lidoCalls.length;
  const sparkLen = sparkCalls.length;
  const skyLen = skyCalls.length;
  const stableLen = stablecoinCalls.length;

  const aaveResults = results.slice(0, aaveLen);
  const lidoResults = results.slice(aaveLen, aaveLen + lidoLen);
  const sparkResults = results.slice(
    aaveLen + lidoLen,
    aaveLen + lidoLen + sparkLen
  );
  const skyResults = results.slice(
    aaveLen + lidoLen + sparkLen,
    aaveLen + lidoLen + sparkLen + skyLen
  );
  const stablecoinResults = results.slice(
    aaveLen + lidoLen + sparkLen + skyLen,
    aaveLen + lidoLen + sparkLen + skyLen + stableLen
  );
  const chainlinkResults = results.slice(
    aaveLen + lidoLen + sparkLen + skyLen + stableLen
  );

  // ── Decode positions ────────────────────────────────────────────────────────
  const sparkPositions = decodeSparkResults(sparkResults, userAddress, chainId);
  const skyPositions = decodeSkyResults(skyResults, userAddress, chainId);

  // Price Sky position: decode maxWithdraw (skyResults[1]) to get USDS
  // underlying amount, then resolve the USDS USD price via DefiLlama fallback
  // (USDS has no Chainlink feed). Sets usdValue + totalCollateralUsd in-place.
  // A price miss leaves usdValue null but keeps the position (T-56-04 guard).
  const firstSkyPos = skyPositions[0];
  const firstSkyAsset = firstSkyPos?.suppliedAssets[0];
  if (
    firstSkyPos !== undefined &&
    firstSkyAsset !== undefined &&
    skyResults[1]?.success === true &&
    skyResults[1].returnData !== "0x"
  ) {
    // Defensive decode/price: a non-conformant vault can report success with
    // malformed maxWithdraw data, and pricing can reject. A throw here would
    // propagate through scanOneChain and mark the WHOLE chain unavailable
    // (losing Aave/Lido/Spark/stablecoin data too), violating the never-throws
    // contract. Swallow any failure and leave usdValue null — the Sky position
    // is still emitted (T-56-04 guard).
    try {
      const [rawMaxWithdraw] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint256"],
        skyResults[1].returnData
      );
      const usdsAmount = rawMaxWithdraw as bigint;
      const skySavingsEntry = SKY_SAVINGS[chainId];
      const usdsPrice = skySavingsEntry
        ? await resolveUsdPrice(chainId, skySavingsEntry.usds, "USDS", {})
        : null;
      const usdValue =
        usdsPrice === null ? null : (Number(usdsAmount) / 1e18) * usdsPrice;
      firstSkyAsset.usdValue = usdValue;
      firstSkyPos.totalCollateralUsd = usdValue;
    } catch {
      // Malformed maxWithdraw data or pricing failure — leave usdValue null
      // and keep the position rather than failing the entire chain scan.
    }
  }

  // Price Lido staking assets via resolveUsdPrice (no Chainlink feed is
  // registered for stETH/wstETH, so this resolves through the DefiLlama
  // fallback by token address). Without this pass a Lido-only wallet carries
  // usdValue null everywhere, fails the suggestion engine's dust filter, and
  // the funnel renders "No positions found" for a large staker. Same
  // never-throws contract as the Sky pricing pass above: a price miss leaves
  // usdValue null and keeps the position (T-56-04 guard).
  const lidoPositions = decodeLidoResults(lidoResults, userAddress, chainId);
  for (const lidoPos of lidoPositions) {
    const pricedAssets = await Promise.all(
      lidoPos.suppliedAssets.map(async (asset) => ({
        asset,
        priceUsd: await resolveUsdPrice(
          chainId,
          asset.tokenAddress,
          asset.symbol,
          {}
        ).catch(() => null),
      }))
    );
    let lidoTotalUsd: number | null = null;
    for (const { asset, priceUsd } of pricedAssets) {
      if (priceUsd !== null) {
        // Number precision loss acceptable for display value — raw amount preserved.
        const usdValue =
          (Number(BigInt(asset.amount)) / 10 ** asset.decimals) * priceUsd;
        asset.usdValue = usdValue;
        lidoTotalUsd = (lidoTotalUsd ?? 0) + usdValue;
      }
    }
    lidoPos.totalCollateralUsd = lidoTotalUsd;
  }

  const positions: ProtocolPosition[] = [
    ...decodeAaveV3Results(aaveResults, userAddress, chainId),
    ...lidoPositions,
    ...sparkPositions,
    ...skyPositions,
  ];

  // ── Decode stablecoin balances + apply pricing ──────────────────────────────
  const rawStablecoins = decodeStablecoinResults(
    stablecoinResults,
    chainStablecoins,
    chainId
  );

  // Map stablecoin array index → its Chainlink result (when a feed was batched).
  const chainlinkByStableIdx = new Map<number, MulticallResult>();
  for (const [i, feedIdx] of chainlinkFeedIndices.entries()) {
    const clResult = chainlinkResults[i];
    if (clResult !== undefined) {
      chainlinkByStableIdx.set(feedIdx, clResult);
    }
  }

  const pricedStablecoins: StablecoinBalance[] = await Promise.all(
    rawStablecoins.map(async (stable) => {
      // Locate the original index of this token in chainStablecoins so we can
      // retrieve the Chainlink result that was paired to it above.
      const tokenIdx = chainStablecoins.findIndex(
        (t) =>
          t.tokenAddress === stable.tokenAddress && t.symbol === stable.symbol
      );
      const chainlinkResult =
        tokenIdx >= 0 ? chainlinkByStableIdx.get(tokenIdx) : undefined;

      const priceUsd = await resolveUsdPrice(
        chainId,
        stable.tokenAddress,
        stable.symbol,
        { chainlinkResult }
      );

      const depegged = priceUsd === null ? false : isDepegged(priceUsd);
      // Number precision loss acceptable for display value — raw amount preserved.
      const usdValue =
        priceUsd === null
          ? null
          : (Number(BigInt(stable.amount)) / 10 ** stable.decimals) * priceUsd;

      return {
        ...stable,
        priceUsd,
        depegged,
        usdValue,
      };
    })
  );

  return { chainId, positions, stablecoins: pricedStablecoins };
}

/** Per-chain timeout for the getCode address-kind probe. */
const ADDRESS_KIND_TIMEOUT_MS = 3000;

/**
 * EIP-7702 delegation designator prefix (0xef0100 || delegate address).
 * An EOA with a live delegation returns this 23-byte designator from
 * eth_getCode, but the account is still an EOA — EIP-3541 guarantees no
 * deployed contract's code can start with 0xEF, so the prefix check is
 * unambiguous.
 */
const EIP7702_DELEGATION_PREFIX = "0xef0100";

/**
 * True when eth_getCode output indicates deployed contract bytecode.
 * Empty code and EIP-7702 delegation designators both classify as EOA.
 */
export function isContractCode(code: string): boolean {
  return (
    code !== "0x" && !code.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX)
  );
}

/**
 * Detect whether the scanned address is an EOA or a deployed contract.
 *
 * Probes `eth_getCode` on every scannable chain in parallel (bytecode can
 * exist on some chains and not others, e.g. an L2-only Safe). A chain whose
 * probe fails or times out is ignored. Returns `addressKind: undefined` when
 * every probe failed — callers omit the field rather than guessing.
 */
async function detectAddressKind(
  address: string,
  chainIds: number[]
): Promise<{
  addressKind: "eoa" | "contract" | undefined;
  contractChains: number[];
}> {
  const probes = await Promise.allSettled(
    chainIds.map(async (chainId) => {
      const rpcManager = await getRpcProvider({ chainId });
      const code = await Promise.race([
        rpcManager.executeWithFailover((provider: ethers.JsonRpcProvider) =>
          provider.getCode(address)
        ),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("getCode timeout")),
            ADDRESS_KIND_TIMEOUT_MS
          );
        }),
      ]);
      return { chainId, isContract: isContractCode(code) };
    })
  );

  const fulfilled = probes.filter(
    (
      p
    ): p is PromiseFulfilledResult<{ chainId: number; isContract: boolean }> =>
      p.status === "fulfilled"
  );
  const contractChains = fulfilled
    .filter((p) => p.value.isContract)
    .map((p) => p.value.chainId);

  if (fulfilled.length === 0) {
    return { addressKind: undefined, contractChains: [] };
  }
  return {
    addressKind: contractChains.length > 0 ? "contract" : "eoa",
    contractChains,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan an EVM address for DeFi positions across all registered chains.
 *
 * Cache short-circuit (SCAN-13): a fresh `scan_results` row (expiresAt > NOW)
 * returns the cached `ScanResponse` with zero RPC calls. On a cache miss,
 * all scannable chains are fanned out in parallel (4s per-chain timeout via
 * `scanChains`). Results are assembled into a `ScanResponse` with
 * `schemaVersion: 1`, written to the cache with a 5-minute TTL, and returned.
 *
 * Partial failure is a first-class state: chains that time out or error appear
 * in `unavailableChains[]`; healthy chains' positions are still returned.
 *
 * Zerion fallback (SCAN-12): `maybeZerionFallback` is called after native
 * scanning. In Phase 51 it always returns [] — native positions take precedence
 * for the same (protocol, chainId) pair when Phase 52 wires the real adapter.
 */
export async function scanAddress(rawAddress: string): Promise<ScanResponse> {
  const cacheKey = normalizeAddressForStorage(rawAddress);

  // 1. Cache short-circuit (SCAN-13): return instantly if a fresh row exists.
  const cached = await db
    .select()
    .from(scanResults)
    .where(
      and(
        eq(scanResults.address, cacheKey),
        gt(scanResults.expiresAt, new Date())
      )
    )
    .limit(1);

  if (cached[0] !== undefined) {
    getMetricsCollector().incrementCounter(MetricNames.SCAN_CACHE_HIT_TOTAL);
    recordScanCacheLookup("hit");
    return cached[0].resultJson;
  }

  getMetricsCollector().incrementCounter(MetricNames.SCAN_CACHE_MISS_TOTAL);
  recordScanCacheLookup("miss");

  // 2. Determine which chains to scan (intersection of enabled chains and
  //    chains that have at least one registered Aave V3 or Lido address).
  const enabledChains = await getEnabledChains();
  const enabledChainIds = enabledChains.map((c) => c.chainId);
  const chainIds = scannableChainIds(enabledChainIds);

  // 3. Fan out per-chain with 4s timeout isolation (SCAN-08). The address-kind
  //    probe runs concurrently so it adds no wall-clock latency.
  const addressKindPromise = detectAddressKind(rawAddress, chainIds);
  const { chainOutputs, unavailableChains } = await scanChains(
    chainIds,
    (chainId) => scanOneChain(chainId, rawAddress)
  );
  const { addressKind, contractChains } = await addressKindPromise;

  // 4. Zerion breadth fallback (SCAN-12, Phase 51: no-op stub).
  //    Native positions take precedence by (protocol, chainId).
  //    TODO(HARDEN-03): increment MetricNames.SCAN_ZERION_CALLS_TOTAL here
  //    when the real Zerion adapter is wired (stays 0 in v1.13 by design).
  const zerionPositions = await maybeZerionFallback(rawAddress, chainIds);
  const nativeKeys = new Set<string>(
    chainOutputs.flatMap((output) =>
      output.positions.map((p) => `${p.protocol}:${p.chainId}`)
    )
  );
  const mergedZerion = zerionPositions.filter(
    (p) => !nativeKeys.has(`${p.protocol}:${p.chainId}`)
  );

  // 5. Assemble ScanResponse.
  const positions: ProtocolPosition[] = [
    ...chainOutputs.flatMap((output) => output.positions),
    ...mergedZerion,
  ];
  const stablecoins: StablecoinBalance[] = chainOutputs.flatMap(
    (output) => output.stablecoins
  );

  const response: ScanResponse = {
    schemaVersion: SCAN_SCHEMA_VERSION,
    address: toChecksumAddress(rawAddress),
    positions,
    stablecoins,
    unavailableChains,
    scannedAt: new Date().toISOString(),
    ...(addressKind === undefined ? {} : { addressKind }),
    ...(contractChains.length > 0 ? { contractChains } : {}),
  };

  // 6. Write cache row with 5-min TTL (SCAN-13). Upsert on the unique address
  //    key so concurrent cache misses converge to one row rather than
  //    accumulating duplicates. A cache-write failure must never discard a
  //    successfully computed scan — swallow it and still return the result.
  try {
    const now = new Date();
    await db
      .insert(scanResults)
      .values({
        address: cacheKey,
        resultJson: response,
        scannedAt: now,
        expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
      })
      .onConflictDoUpdate({
        target: scanResults.address,
        set: {
          resultJson: response,
          scannedAt: now,
          expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
        },
      });
  } catch {
    // Cache is best-effort; the scan already succeeded.
  }

  return response;
}
