// Chains with a fixed 12 s slot clock: chain id -> genesis time (unix seconds).
// The app's ETHEREUM_L1_CHAIN_IDS (lib/web3/ethereum-l1.ts); an app test checks they agree.
export const SLOT_CLOCK_GENESIS: Readonly<Record<number, number>> = {
  1: 1_606_824_023,
  11155111: 1_655_733_600,
  560048: 1_742_213_400,
};

// Slot timing as of Pectra; revisit on a fork that changes it (e.g. ePBS).
export const SLOT_SECONDS = 12;
// A slot with no block this long after its start counts as missed.
export const MISSED_SLOT_CHECK_DELAY_MS = 4000;

/** Unix seconds at which a slot starts. */
export function slotStartSeconds(genesis: number, slot: number): number {
  return genesis + slot * SLOT_SECONDS;
}

/** The slot a block with this timestamp (Unix seconds) belongs to. */
export function slotAt(genesis: number, timestampSeconds: number): number {
  return Math.floor((timestampSeconds - genesis) / SLOT_SECONDS);
}

/** The first slot whose check time (start + 4 s) is after `nowMs`. */
export function nextSlotToCheck(genesis: number, nowMs: number): number {
  const sinceGenesisMs = nowMs - MISSED_SLOT_CHECK_DELAY_MS - genesis * 1000;
  return Math.floor(sinceGenesisMs / (SLOT_SECONDS * 1000)) + 1;
}

/** Milliseconds from `nowMs` until a slot's check time (0 if already past). */
export function msUntilSlotCheck(
  genesis: number,
  slot: number,
  nowMs: number,
): number {
  const checkAtMs =
    slotStartSeconds(genesis, slot) * 1000 + MISSED_SLOT_CHECK_DELAY_MS;
  return Math.max(0, checkAtMs - nowMs);
}
