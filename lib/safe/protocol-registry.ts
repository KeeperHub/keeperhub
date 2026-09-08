import type { TemplateSlug } from "@/lib/safe/condition-templates";

/**
 * Every protocol the policy wizard surfaces. Catalog keys match the server
 * and client, and the `enforcementLevel` field drives the UI badge that
 * tells admins whether they get full per-parameter policy on a protocol
 * or just target-level allowlisting.
 *
 * Safe (read-only module helper) and Chronicle (oracle reads) are not
 * included because neither spends tokens; they do not need role
 * enforcement.
 */
export type ProtocolSlug =
  | "aave-v3"
  | "aave-v4"
  | "compound-v3"
  | "cowswap"
  | "uniswap-v3"
  | "curve"
  | "lido"
  | "rocket-pool"
  | "morpho"
  | "spark"
  | "sky"
  | "ethena"
  | "yearn-v3"
  | "pendle"
  | "aerodrome"
  | "ajna"
  | "chainlink"
  | "wrapped";

export type EnforcementLevel = "per-parameter" | "contract-allowlist";

export type ProtocolCatalogEntry = {
  slug: ProtocolSlug;
  label: string;
  description: string;
  docsUrl: string;
  templateSlug: TemplateSlug;
  enforcementLevel: EnforcementLevel;
  /** Chains where at least one target contract exists (see protocol-targets) */
  chainIds: readonly number[];
};

export const ENFORCEMENT_LEVEL_LABELS: Readonly<
  Record<EnforcementLevel, string>
> = {
  "per-parameter": "Per-parameter policy",
  "contract-allowlist": "Contract allowlist",
} as const;

export const ENFORCEMENT_LEVEL_TOOLTIPS: Readonly<
  Record<EnforcementLevel, string>
> = {
  "per-parameter":
    "KeeperHub controls which functions can be called and with what arguments. Example for Aave V3: only supply(USDC, recipient = your Safe) is allowed; arbitrary calls revert. Per-token spending caps apply on top.",
  "contract-allowlist":
    "KeeperHub lets workflows call any function on this protocol's contracts. The contract itself decides what's valid. Per-token spending caps still apply. Used when a per-parameter template hasn't shipped yet for this protocol.",
} as const;

const ETH = 1;
const OPT = 10;
const BASE = 8453;
const ARB = 42_161;

export const PROTOCOL_CATALOG: Readonly<
  Record<ProtocolSlug, ProtocolCatalogEntry>
> = {
  "aave-v3": {
    slug: "aave-v3",
    label: "Aave V3",
    description:
      "Supply, borrow, withdraw, repay on Aave V3. Recipient pinned to the Safe via the defi-kit preset.",
    docsUrl: "https://aave.com/docs",
    templateSlug: "aave-v3",
    enforcementLevel: "per-parameter",
    chainIds: [ETH, BASE, ARB, OPT],
  },
  "aave-v4": {
    slug: "aave-v4",
    label: "Aave V4",
    description:
      "Hub-and-Spoke supply and borrow via the Lido Spoke. Role scopes the Spoke contract at target level until a V4 per-parameter template ships.",
    docsUrl: "https://aave.com/docs/concepts/v4",
    templateSlug: "target-only",
    enforcementLevel: "contract-allowlist",
    chainIds: [ETH],
  },
  "compound-v3": {
    slug: "compound-v3",
    label: "Compound V3 (Comet)",
    description: "Supply and borrow on the Compound V3 Comet USDC markets.",
    docsUrl: "https://docs.compound.finance/",
    templateSlug: "compound-v3",
    enforcementLevel: "per-parameter",
    chainIds: [ETH, BASE, ARB],
  },
  cowswap: {
    slug: "cowswap",
    label: "CoW Protocol",
    description:
      "MEV-protected batch swaps via GPv2Settlement. Recipient pinned to the Safe.",
    docsUrl: "https://docs.cow.fi/",
    templateSlug: "cowswap",
    enforcementLevel: "per-parameter",
    chainIds: [ETH, BASE, ARB, OPT],
  },
  "uniswap-v3": {
    slug: "uniswap-v3",
    label: "Uniswap V3",
    description:
      "Single and multi-hop swaps via the Uniswap V3 router between allowed tokens.",
    docsUrl: "https://docs.uniswap.org/contracts/v3/overview",
    templateSlug: "uniswap-v3",
    enforcementLevel: "per-parameter",
    chainIds: [ETH, BASE, ARB, OPT],
  },
  curve: {
    slug: "curve",
    label: "Curve",
    description:
      "Stable-swap and meta-pool trading. Target-only today; per-pool conditions will ship with individual pool templates.",
    docsUrl: "https://docs.curve.fi/",
    templateSlug: "target-only",
    enforcementLevel: "contract-allowlist",
    chainIds: [ETH],
  },
  lido: {
    slug: "lido",
    label: "Lido",
    description:
      "Stake ETH for stETH / wstETH. Trivial one-function ABI; condition enforced.",
    docsUrl: "https://docs.lido.fi/",
    templateSlug: "lido",
    enforcementLevel: "per-parameter",
    chainIds: [ETH],
  },
  "rocket-pool": {
    slug: "rocket-pool",
    label: "Rocket Pool",
    description:
      "Mint rETH by depositing ETH into the Rocket Pool deposit pool.",
    docsUrl: "https://docs.rocketpool.net/",
    templateSlug: "rocket-pool",
    enforcementLevel: "per-parameter",
    chainIds: [ETH],
  },
  morpho: {
    slug: "morpho",
    label: "Morpho Blue",
    description:
      "Overcollateralised lending via the Morpho Blue singleton and MetaMorpho vaults. Target-only today.",
    docsUrl: "https://docs.morpho.org/morpho-blue",
    templateSlug: "target-only",
    enforcementLevel: "contract-allowlist",
    chainIds: [ETH, BASE],
  },
  spark: {
    slug: "spark",
    label: "Spark",
    description: "Maker's Aave V3 fork. Supply and borrow with per-token caps.",
    docsUrl: "https://docs.spark.fi/",
    templateSlug: "spark",
    enforcementLevel: "per-parameter",
    chainIds: [ETH],
  },
  sky: {
    slug: "sky",
    label: "Sky (MakerDAO)",
    description:
      "Deposit DAI / USDS and swap via Peg Stability Modules. Target-only today.",
    docsUrl: "https://docs.sky.money/",
    templateSlug: "target-only",
    enforcementLevel: "contract-allowlist",
    chainIds: [ETH],
  },
  ethena: {
    slug: "ethena",
    label: "Ethena",
    description:
      "USDe and sUSDe deposits, withdrawals, yield. Target-only today.",
    docsUrl: "https://ethena-labs.gitbook.io/ethena-labs",
    templateSlug: "target-only",
    enforcementLevel: "contract-allowlist",
    chainIds: [ETH],
  },
  "yearn-v3": {
    slug: "yearn-v3",
    label: "Yearn V3",
    description:
      "ERC-4626 yield vaults. User-specified vault contracts scoped at target level.",
    docsUrl: "https://docs.yearn.finance/",
    templateSlug: "target-only",
    enforcementLevel: "contract-allowlist",
    chainIds: [ETH, ARB],
  },
  pendle: {
    slug: "pendle",
    label: "Pendle",
    description:
      "Fixed and variable yield via PT and YT tokens. Router scoped at target level.",
    docsUrl: "https://docs.pendle.finance/",
    templateSlug: "target-only",
    enforcementLevel: "contract-allowlist",
    chainIds: [ETH, BASE, ARB, OPT],
  },
  aerodrome: {
    slug: "aerodrome",
    label: "Aerodrome (Base)",
    description: "Base-native ve(3,3) DEX. Router scoped at target level.",
    docsUrl: "https://docs.aerodrome.finance/",
    templateSlug: "target-only",
    enforcementLevel: "contract-allowlist",
    chainIds: [BASE],
  },
  ajna: {
    slug: "ajna",
    label: "Ajna",
    description:
      "Oracle-free permissionless lending pools. Pool info scoped at target level.",
    docsUrl: "https://www.ajna.finance/",
    templateSlug: "target-only",
    enforcementLevel: "contract-allowlist",
    chainIds: [BASE],
  },
  chainlink: {
    slug: "chainlink",
    label: "Chainlink CCIP",
    description: "Cross-chain messaging and token transfers via CCIP routers.",
    docsUrl: "https://docs.chain.link/ccip",
    templateSlug: "target-only",
    enforcementLevel: "contract-allowlist",
    chainIds: [ETH, BASE, ARB, OPT],
  },
  wrapped: {
    slug: "wrapped",
    label: "Wrapped Native (WETH)",
    description:
      "Wrap ETH into WETH and unwrap back. Two functions only: deposit + withdraw.",
    docsUrl: "https://weth.io/",
    templateSlug: "wrapped",
    enforcementLevel: "per-parameter",
    chainIds: [ETH, BASE, ARB, OPT],
  },
} as const;

export function listProtocolsForChain(chainId: number): ProtocolCatalogEntry[] {
  const out: ProtocolCatalogEntry[] = [];
  for (const entry of Object.values(PROTOCOL_CATALOG)) {
    if (entry.chainIds.includes(chainId)) {
      out.push(entry);
    }
  }
  return out;
}

export function isProtocolAvailableOnChain(
  slug: ProtocolSlug,
  chainId: number
): boolean {
  return PROTOCOL_CATALOG[slug]?.chainIds.includes(chainId) ?? false;
}

/**
 * Resolve a protocol slug (e.g. "pendle", "aave-v3") to its display label
 * (e.g. "Pendle", "Aave V3") via PROTOCOL_CATALOG. Falls back to the raw
 * slug when no catalog entry exists -- happens for chain-only protocols
 * skipped during install or for legacy / synthetic slugs (e.g. the
 * "direct" rule slug); better to show the unmapped string than to crash
 * the surface. Use everywhere we render a protocol name to a human.
 */
export function getProtocolLabel(slug: string): string {
  return PROTOCOL_CATALOG[slug as ProtocolSlug]?.label ?? slug;
}

export const DEFAULT_ENABLED_PROTOCOLS: readonly ProtocolSlug[] = [
  "aave-v3",
  "cowswap",
] as const;
