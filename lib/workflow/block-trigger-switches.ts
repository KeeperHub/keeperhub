import { isSolanaChain } from "@/lib/rpc/solana-chains";
import { resolveSwitch } from "@/lib/utils";

// Chains with a fixed 12 s slot clock (Ethereum Mainnet, Sepolia, Hoodi).
// Keep in sync with SLOT_CLOCK_GENESIS in keeperhub-scheduler/lib/slot-clock.ts.
const SLOT_CLOCK_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, 11_155_111, 560_048,
]);

export const SKIP_IF_RUNNING_LABEL =
  "Skip if the previous run is still running";
export const RUN_ON_MISSED_SLOT_LABEL = "Also run when a slot is missed";

/** Whether a trigger's network (a chain id, as stored) runs on a slot clock. */
export function isSlotClockChain(network: unknown): boolean {
  const chainId = Number(network);
  return SLOT_CLOCK_CHAIN_IDS.has(chainId);
}

/** Skip-if-running is dispatched by the EVM block dispatcher only. */
export function isSkipIfRunningSupported(network: unknown): boolean {
  return !isSolanaChain(Number(network));
}

/** A Block Trigger switch as every reader sees it: true or "true" is on. */
export function blockSwitchOn(
  config: Record<string, unknown>,
  key: string
): boolean {
  return resolveSwitch(config[key], false) === true;
}

/** Missed-slot runs happen: option on, slot-clock chain, Block Interval 1 (unset reads as 1, as the dispatcher does). */
export function missedSlotRunsApply(config: Record<string, unknown>): boolean {
  return (
    blockSwitchOn(config, "runOnMissedSlot") &&
    isSlotClockChain(config.network) &&
    (Number(config.blockInterval) || 1) === 1
  );
}
