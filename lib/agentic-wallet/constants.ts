/**
 * Agentic-wallet shared constants. Single source of truth for USDC contract
 * addresses and chain ids used across policy.ts, sign.ts, and the /sign route.
 *
 * Source: Phase 33 CONTEXT Resolution #2 (locked 2026-04-21).
 */

export const USDC_BASE_ADDRESS =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const USDC_TEMPO_ADDRESS =
  "0x20c000000000000000000000b9537d11c60e8b50" as const;

export const USDC_BASE_LC = USDC_BASE_ADDRESS.toLowerCase();
export const USDC_TEMPO_LC = USDC_TEMPO_ADDRESS.toLowerCase();

export const BASE_CHAIN_ID = 8453 as const;
export const TEMPO_MAINNET_CHAIN_ID = 4217 as const;
// Tempo testnet — matches the Tempo public testnet chain id. Confirmed
// against the Tempo network docs at writing-plans research time.
export const TEMPO_TESTNET_CHAIN_ID = 4218 as const;

// Phase 37 fix #3: MPP chainId enum. /sign rejects any chainId not in this
// list with 400 BAD_CHAIN_ID — defence in depth for the eth.eip_712 Turnkey
// policy and a guard against malformed inputs that would otherwise round-trip
// to Turnkey before being rejected.
export const ALLOWED_TEMPO_CHAIN_IDS: readonly number[] = [
  TEMPO_MAINNET_CHAIN_ID,
  TEMPO_TESTNET_CHAIN_ID,
] as const;

// ERC-8004 Trustless Agents — Ethereum mainnet deployments (2026-01-29 launch).
// Vanity prefix 0x8004 distinguishes the registries on-chain. Source-of-truth:
// https://github.com/erc-8004/erc-8004-contracts
export const ETHEREUM_MAINNET_CHAIN_ID = 1 as const;
export const ERC_8004_IDENTITY_REGISTRY_ADDRESS =
  "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export const ERC_8004_REPUTATION_REGISTRY_ADDRESS =
  "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const;
export const ERC_8004_IDENTITY_REGISTRY_LC =
  ERC_8004_IDENTITY_REGISTRY_ADDRESS.toLowerCase();
export const ERC_8004_REPUTATION_REGISTRY_LC =
  ERC_8004_REPUTATION_REGISTRY_ADDRESS.toLowerCase();

// keccak256("giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)")[0:4]
export const GIVE_FEEDBACK_SELECTOR = "0x3c036a7e" as const;

// KeeperHub's own ERC-8004 agent NFT id on Ethereum mainnet. Used as the
// default rated agent when injecting feedback CTAs into workflow execution
// responses; users can rate any agent id (the Turnkey policy does not
// constrain the agentId argument).
export const KEEPERHUB_ERC_8004_AGENT_ID = 31_875 as const;
