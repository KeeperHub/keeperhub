import { ETHEREUM_L1_CHAIN_IDS } from "@/lib/web3/ethereum-l1";

// Beacon chains keep to fixed wall-clock slots and leave a missed slot's
// timestamp unused: Ethereum L1 and Holesky (12 s), Gnosis and Chiado (5 s).
const BEACON_SLOT_SECONDS = new Map<number, number>([
  ...[...ETHEREUM_L1_CHAIN_IDS, 17_000].map((id): [number, number] => [id, 12]),
  [100, 5],
  [10_200, 5],
]);

/** The chain's fixed slot length in seconds, on beacon chains only. */
export function beaconSlotSeconds(chainId: number): number | undefined {
  return BEACON_SLOT_SECONDS.get(chainId);
}

/**
 * The least time between a block and its parent that the chain guarantees: one
 * slot on beacon chains. Undefined elsewhere: timestamps may repeat (Arbitrum, BSC).
 */
export function minBlockGapSeconds(chainId: number): number | undefined {
  return BEACON_SLOT_SECONDS.get(chainId);
}
