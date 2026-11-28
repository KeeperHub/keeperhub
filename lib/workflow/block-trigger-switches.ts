import { isSolanaChain } from "@/lib/rpc/solana-chains";
import { resolveSwitch } from "@/lib/utils";
import { ETHEREUM_L1_CHAIN_IDS } from "@/lib/web3/ethereum-l1";

export const SKIP_IF_RUNNING_LABEL =
  "Skip if the previous run is still running";
export const RUN_ON_MISSED_SLOT_LABEL = "Also run when a slot is missed";

/** Whether a trigger's network (a chain id, as stored) runs on a 12 s slot clock (Ethereum L1). */
export function isSlotClockChain(network: unknown): boolean {
  return ETHEREUM_L1_CHAIN_IDS.has(Number(network));
}

/** Skip-if-running is dispatched by the EVM block dispatcher only. */
export function isSkipIfRunningSupported(network: unknown): boolean {
  return !isSolanaChain(Number(network));
}

// true or "true" is on, as the scheduler's own isOn reads it.
function blockSwitchOn(config: Record<string, unknown>, key: string): boolean {
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
