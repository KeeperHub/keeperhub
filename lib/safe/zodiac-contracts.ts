/**
 * Zodiac Roles Modifier v2 contract address registry.
 *
 * Roles v2.0.0 uses deterministic deployment (Nick's method) so the singleton
 * and ModuleProxyFactory addresses are identical across all supported chains.
 * Per-chain overrides are supported via CHAIN_OVERRIDES for chains that have
 * a non-canonical deployment.
 *
 * Source: https://github.com/gnosisguild/zodiac-modifier-roles/blob/main/packages/deployments
 * and verified via Clawlett (https://github.com/Creator-Bid/Clawlett) contract
 * constants + on-chain inspection.
 */

import { ethers } from "ethers";

export const ZODIAC_ROLES_VERSION: string = "2.0.0";

export type ZodiacContractAddresses = {
  /** Roles Modifier v2 implementation singleton (master copy) */
  rolesSingleton: string;
  /** Zodiac ModuleProxyFactory used to deploy a per-Safe Roles proxy */
  moduleProxyFactory: string;
};

const CANONICAL_ADDRESSES: ZodiacContractAddresses = {
  rolesSingleton: "0x9646fDAD06d3e24444381f44362a3B0eB343D337",
  moduleProxyFactory: "0x000000000000aDdB49795b0f9bA5BC298cDda236",
} as const;

/**
 * Per-chain overrides for chains that do not use the canonical Zodiac
 * deployment. Populated empty today; if a chain ever ships Roles v2 at a
 * non-canonical address, add the override here.
 */
const CHAIN_OVERRIDES: Record<number, Partial<ZodiacContractAddresses>> = {};

/**
 * Chains where Roles v2 is verified to exist at the canonical CREATE2
 * addresses (singleton + ModuleProxyFactory both have bytecode on chain).
 *
 * Verified 2026-05-06 via direct `eth_getCode` probes against:
 *   - rolesSingleton:      0x9646fDAD06d3e24444381f44362a3B0eB343D337
 *   - moduleProxyFactory:  0x000000000000aDdB49795b0f9bA5BC298cDda236
 *
 * Avalanche Fuji (43113) is INTENTIONALLY excluded: the ModuleProxyFactory
 * is deployed there, but the Roles singleton at the canonical address
 * returns `0x` (no bytecode). Any install attempt would deploy a proxy
 * pointing at an empty implementation and revert. Re-add 43113 once the
 * singleton is deployed (re-run the eth_getCode probe to confirm).
 */
const ROLES_SUPPORTED_CHAIN_IDS: ReadonlySet<number> = new Set([
  // mainnets
  1, // Ethereum
  10, // Optimism
  56, // BNB Smart Chain
  137, // Polygon
  8453, // Base
  42_161, // Arbitrum One
  43_114, // Avalanche C-Chain
  // testnets
  97, // BSC testnet
  80_002, // Polygon Amoy
  84_532, // Base Sepolia
  421_614, // Arbitrum Sepolia
  11_155_111, // Sepolia
  11_155_420, // Optimism Sepolia
]);

export function isRolesSupportedChain(chainId: number): boolean {
  return ROLES_SUPPORTED_CHAIN_IDS.has(chainId);
}

export function getZodiacContracts(chainId: number): ZodiacContractAddresses {
  const overrides = CHAIN_OVERRIDES[chainId] ?? {};
  return { ...CANONICAL_ADDRESSES, ...overrides };
}

export function getRolesSingletonAddress(chainId: number): string {
  return getZodiacContracts(chainId).rolesSingleton;
}

export function getModuleProxyFactoryAddress(chainId: number): string {
  return getZodiacContracts(chainId).moduleProxyFactory;
}

/**
 * Role key helpers. Zodiac Roles uses `bytes32` identifiers for each role.
 * Our convention: keccak256("kh-role:" || orgId || ":" || chainId || ":automation").
 * Using a deterministic derivation means the role key is reproducible if we
 * ever need to re-derive it (e.g. to query on-chain state).
 *
 * Collision note (review #923-r1, LOW): `solidityPacked` does not
 * length-prefix strings, so in principle two distinct `(orgId, chainId)`
 * pairs could produce identical packed bytes if an orgId contained a `:`.
 * UUID v4 orgIds (our current format) never contain `:`, so this is safe
 * today. Hashing orgId before packing would close the speculative gap but
 * is a BREAKING change for already-deployed Safes — their on-chain
 * `assignRoles` was bound to keys derived under the current packing, so
 * a derivation change would orphan every existing role. Migration would
 * need a coordinated re-assign. Tracked but not fixed here.
 */
export function orgAutomationRoleKey(
  organizationId: string,
  chainId: number
): string {
  const encoded = ethers.solidityPacked(
    ["string", "string", "string", "uint256", "string"],
    ["kh-role:", organizationId, ":", BigInt(chainId), ":automation"]
  );
  return ethers.keccak256(encoded);
}

/**
 * Allowance key helpers. Zodiac allowances are keyed by `bytes32`. We derive
 * per-(role, protocol, token) allowance keys so each protocol owns its own
 * spending bucket. Two protocols touching the same token (e.g. Aave V3 and
 * CoW both holding USDC) get independent caps that the admin can configure
 * separately on the wizard's per-protocol cards.
 *
 * The protocol slug is hashed into a `bytes32` via `ethers.id` so it
 * abi-packs cleanly alongside the existing `roleKey` + `address` operands.
 */
export function tokenAllowanceKey(
  roleKey: string,
  protocolSlug: string,
  tokenAddress: string
): string {
  const protocolDigest = ethers.id(protocolSlug);
  const encoded = ethers.solidityPacked(
    ["bytes32", "bytes32", "address"],
    [roleKey, protocolDigest, ethers.getAddress(tokenAddress)]
  );
  return ethers.keccak256(encoded);
}

/**
 * Direct-rule allowance key. Direct rules differ from protocol presets in
 * that two rules can target the same `(roleKey, "direct", token)` triple
 * but represent independent buckets — e.g. an `erc20-approve` to spender A
 * and an `erc20-transfer` to recipient B should not share a weekly cap.
 *
 * Including `kind` and `counterparty` in the digest gives each direct rule
 * its own on-chain allowance bucket so the wizard's per-rule cap matches
 * what the modifier actually enforces.
 *
 * IMPORTANT — case sensitivity (review #923-r1, LOW): the `counterparty`
 * is lowercased before being folded into the digest, while `tokenAddress`
 * is checksum-normalised via `ethers.getAddress`. Any external caller
 * reconstructing this key MUST lowercase the counterparty first, otherwise
 * the same `(role, kind, recipient, token)` tuple produces a different
 * keccak256 and the modifier read misses the bucket. Pass the address as
 * literally typed (mixed-case OK) — this function handles the folding.
 */
export function directRuleAllowanceKey(
  roleKey: string,
  kind: string,
  counterparty: string,
  tokenAddress: string
): string {
  const ruleDigest = ethers.id(`direct:${kind}:${counterparty.toLowerCase()}`);
  const encoded = ethers.solidityPacked(
    ["bytes32", "bytes32", "address"],
    [roleKey, ruleDigest, ethers.getAddress(tokenAddress)]
  );
  return ethers.keccak256(encoded);
}
