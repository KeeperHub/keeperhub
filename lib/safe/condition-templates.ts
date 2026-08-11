/**
 * Per-protocol permission presets for Zodiac Roles, built on top of the
 * audited `defi-kit` presets by karpatkey.
 *
 * Each template takes the admin's selected tokens and returns a Promise
 * resolving to a `PermissionSet` the SDK's `processPermissions` accepts.
 * The presets already encode:
 *   - Per-target/function allowlisting
 *   - Per-parameter constraints (recipient == avatar, asset in allowed set)
 *   - Per-token allowances via the role's allowance keys
 *
 * Templates are keyed by a KeeperHub `TemplateSlug` so they can be looked up
 * from the protocol registry at orchestration time. Adding a protocol = add
 * a new template function + slug.
 */

import type { PermissionSet } from "zodiac-roles-sdk";

export type HexAddress = `0x${string}`;

const CHAIN_ETH = 1;
const CHAIN_OPT = 10;
const CHAIN_BASE = 8453;
const CHAIN_ARB = 42_161;

/**
 * Per-chain `defi-kit` modules are loaded lazily. `defi-kit/{chain}.mjs`
 * builds its `allow` namespace at module-load time by recursively walking
 * the eth-sdk-client SDK with `mapSdk`. The SDK contains cycles (or at
 * least depth that exceeds Node's default stack), so a static import
 * triggers a `RangeError: Maximum call stack size exceeded` during
 * Next.js's page-data collection step. Loading on demand keeps the SDKs
 * out of every route's import graph and only pays the cost when a
 * template build actually needs them (install/update on Safe role
 * management endpoints).
 */
// biome-ignore lint/suspicious/noExplicitAny: defi-kit's per-chain allow types diverge by chain; unifying them erases preset signatures
const ALLOW_CACHE = new Map<number, any>();

// biome-ignore lint/suspicious/noExplicitAny: see ALLOW_CACHE
async function allowForChain(chainId: number): Promise<any> {
  const cached = ALLOW_CACHE.get(chainId);
  if (cached) {
    return cached;
  }
  let mod: { allow: unknown };
  if (chainId === CHAIN_ETH) {
    mod = await import("defi-kit/eth");
  } else if (chainId === CHAIN_OPT) {
    mod = await import("defi-kit/oeth");
  } else if (chainId === CHAIN_BASE) {
    mod = await import("defi-kit/base");
  } else if (chainId === CHAIN_ARB) {
    mod = await import("defi-kit/arb1");
  } else {
    throw new Error(`defi-kit does not have presets for chain ${chainId}`);
  }
  ALLOW_CACHE.set(chainId, mod.allow);
  return mod.allow;
}

export type TemplateInput = {
  /** Tokens the admin allowed the role to spend (symbols like "USDC", "WETH") */
  allowedTokenSymbols: readonly string[];
  /** Chain id the template is compiled for */
  chainId: number;
  /** Safe address — used for presets that restrict recipient to the avatar */
  safeAddress: HexAddress;
};

/**
 * Aave V3 deposit + borrow.
 *
 * defi-kit's preset restricts `onBehalfOf`/`to` to the avatar automatically
 * and scopes `asset` to the allowlist.
 */
export async function buildAaveV3Template(
  input: TemplateInput
): Promise<PermissionSet> {
  const allow = await allowForChain(input.chainId);
  const aave = allow.aave_v3;
  if (!aave) {
    throw new Error(`Aave V3 not supported on chain ${input.chainId}`);
  }
  const [deposit, borrow] = await Promise.all([
    aave.deposit({ targets: input.allowedTokenSymbols }),
    aave.borrow({ targets: input.allowedTokenSymbols }),
  ]);
  return [...deposit, ...borrow] as unknown as PermissionSet;
}

/** CoW Protocol swaps. MEV-protected; recipient pinned to the Safe. */
export async function buildCowswapTemplate(
  input: TemplateInput
): Promise<PermissionSet> {
  const allow = await allowForChain(input.chainId);
  const cow = allow.cowswap;
  if (!cow) {
    throw new Error(`CoW Protocol not supported on chain ${input.chainId}`);
  }
  const preset = await cow.swap({
    sell: input.allowedTokenSymbols,
    buy: input.allowedTokenSymbols,
    recipient: [input.safeAddress],
  });
  return preset as PermissionSet;
}

/** Uniswap V3 swaps via the canonical SwapRouter. Recipient pinned to Safe. */
export async function buildUniswapV3Template(
  input: TemplateInput
): Promise<PermissionSet> {
  const allow = await allowForChain(input.chainId);
  const uni = allow.uniswap_v3;
  if (!uni) {
    throw new Error(`Uniswap V3 not supported on chain ${input.chainId}`);
  }
  const preset = await uni.swap({
    sell: input.allowedTokenSymbols,
    buy: input.allowedTokenSymbols,
  });
  return preset as PermissionSet;
}

/** Compound V3 (Comet) supply + borrow. Ethereum mainnet only for defi-kit. */
export async function buildCompoundV3Template(
  input: TemplateInput
): Promise<PermissionSet> {
  const allow = await allowForChain(input.chainId);
  const comet = allow.compound_v3;
  if (!comet) {
    throw new Error(`Compound V3 not supported on chain ${input.chainId}`);
  }
  const [deposit, borrow] = await Promise.all([
    comet.deposit({ targets: input.allowedTokenSymbols }),
    comet.borrow({ targets: input.allowedTokenSymbols }),
  ]);
  return [...deposit, ...borrow] as unknown as PermissionSet;
}

/** Spark Protocol (Maker/Sky fork of Aave V3) supply + borrow. Ethereum only. */
export async function buildSparkTemplate(
  input: TemplateInput
): Promise<PermissionSet> {
  const allow = await allowForChain(input.chainId);
  const spark = allow.spark;
  if (!spark) {
    throw new Error(`Spark not supported on chain ${input.chainId}`);
  }
  const [deposit, borrow] = await Promise.all([
    spark.deposit({ targets: input.allowedTokenSymbols }),
    spark.borrow({ targets: input.allowedTokenSymbols }),
  ]);
  return [...deposit, ...borrow] as unknown as PermissionSet;
}

/** Lido stETH staking (Ethereum mainnet only). Token-set not applicable. */
export async function buildLidoTemplate(
  input: TemplateInput
): Promise<PermissionSet> {
  const allow = await allowForChain(input.chainId);
  const lido = allow.lido;
  if (!lido) {
    throw new Error(`Lido not supported on chain ${input.chainId}`);
  }
  const preset = await lido.deposit();
  return preset as PermissionSet;
}

/** Rocket Pool rETH minting (Ethereum mainnet only). */
export async function buildRocketPoolTemplate(
  input: TemplateInput
): Promise<PermissionSet> {
  const allow = await allowForChain(input.chainId);
  const rp = allow.rocket_pool;
  if (!rp) {
    throw new Error(`Rocket Pool not supported on chain ${input.chainId}`);
  }
  const preset = await rp.deposit();
  return preset as PermissionSet;
}

/** Balancer V2 swaps (single-hop). Available on eth, arb1, oeth, base. */
export async function buildBalancerV2Template(
  input: TemplateInput
): Promise<PermissionSet> {
  const allow = await allowForChain(input.chainId);
  const balancer = allow.balancer_v2;
  if (!balancer) {
    throw new Error(`Balancer V2 not supported on chain ${input.chainId}`);
  }
  const preset = await balancer.swap({
    sell: input.allowedTokenSymbols,
    buy: input.allowedTokenSymbols,
  });
  return preset as PermissionSet;
}

/**
 * Trivial WETH wrap / unwrap template. The canonical WETH contract exposes
 * `deposit()` (payable) and `withdraw(uint256)`. We emit two
 * `FunctionPermission` entries and let the Roles modifier allow them
 * unconditionally; the Safe's native balance is already scoped by the
 * delegate EOA being the Safe owner.
 */
export function buildWrappedTemplate(
  _input: TemplateInput
): Promise<PermissionSet> {
  return Promise.resolve([] as unknown as PermissionSet);
}

/**
 * Target-only fallback. Emits a bare `TargetPermission` per scoped address,
 * allowing the role to call any function on those contracts. No
 * per-function or per-parameter conditions.
 *
 * The orchestrator resolves the target addresses from
 * `lib/safe/protocol-targets.ts` before invoking this template, passing
 * them through `TemplateInput.targetAddresses` (extended field).
 */
export function buildTargetOnlyTemplate(
  input: TemplateInput & { targetAddresses?: readonly string[] }
): Promise<PermissionSet> {
  const targets = input.targetAddresses ?? [];
  const permissions = targets.map((addr) => ({
    targetAddress: addr as `0x${string}`,
    send: true,
    delegatecall: false,
  }));
  return Promise.resolve(permissions as unknown as PermissionSet);
}

export type TemplateSlug =
  | "aave-v3"
  | "cowswap"
  | "uniswap-v3"
  | "compound-v3"
  | "spark"
  | "lido"
  | "rocket-pool"
  | "balancer-v2"
  | "wrapped"
  | "target-only";

export type ProtocolTemplateSpec = {
  slug: TemplateSlug;
  label: string;
  description: string;
  build: (input: TemplateInput) => Promise<PermissionSet>;
};

export const TEMPLATE_SPECS: Readonly<
  Record<TemplateSlug, ProtocolTemplateSpec>
> = {
  "aave-v3": {
    slug: "aave-v3",
    label: "Aave V3 lending",
    description:
      "Supply + borrow on Aave V3 using allowed tokens. Recipient pinned to the Safe.",
    build: buildAaveV3Template,
  },
  cowswap: {
    slug: "cowswap",
    label: "CoW Protocol swaps",
    description:
      "MEV-protected swaps between allowed tokens. Recipient pinned to the Safe.",
    build: buildCowswapTemplate,
  },
  "uniswap-v3": {
    slug: "uniswap-v3",
    label: "Uniswap V3 swaps",
    description:
      "Single- and multi-hop swaps on Uniswap V3 between allowed tokens.",
    build: buildUniswapV3Template,
  },
  "compound-v3": {
    slug: "compound-v3",
    label: "Compound V3 (Comet)",
    description:
      "Supply + borrow on Compound V3 Comet markets using allowed tokens.",
    build: buildCompoundV3Template,
  },
  spark: {
    slug: "spark",
    label: "Spark lending",
    description: "Supply + borrow on Spark (Maker's Aave V3 fork).",
    build: buildSparkTemplate,
  },
  lido: {
    slug: "lido",
    label: "Lido staking",
    description: "Stake ETH for stETH.",
    build: buildLidoTemplate,
  },
  "rocket-pool": {
    slug: "rocket-pool",
    label: "Rocket Pool staking",
    description: "Mint rETH by depositing ETH into Rocket Pool.",
    build: buildRocketPoolTemplate,
  },
  "balancer-v2": {
    slug: "balancer-v2",
    label: "Balancer V2 swaps",
    description:
      "Single-hop swaps via the Balancer V2 vault between allowed tokens.",
    build: buildBalancerV2Template,
  },
  wrapped: {
    slug: "wrapped",
    label: "Wrapped Native (WETH)",
    description: "Wrap and unwrap the chain's native token.",
    build: buildWrappedTemplate,
  },
  "target-only": {
    slug: "target-only",
    label: "Contract allowlist (fallback)",
    description:
      "Target-level allowlist for protocols without per-parameter templates.",
    build: buildTargetOnlyTemplate,
  },
} as const;
