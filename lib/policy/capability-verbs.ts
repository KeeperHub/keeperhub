import { Capability } from "@/lib/policy/capabilities";

/**
 * Write verbs, most specific first.
 *
 * "unstake" has to be tested before "stake" and "approve" before "transfer",
 * or the broader pattern swallows the narrower one.
 *
 * Shared so the two things that read verbs cannot drift apart: the action-type
 * slug a workflow author chose, and the function name in a contract's ABI. The
 * second is authoritative and the first is not, which is why the same table has
 * to serve both.
 */
export const WRITE_VERB_CAPABILITIES: readonly [RegExp, Capability][] = [
  [/(unstake|undelegate|unwrap)/, Capability.PROTOCOL_STAKING_UNSTAKE],
  [/(stake|delegate)/, Capability.PROTOCOL_STAKING_STAKE],
  [/approve/, Capability.ASSET_APPROVE],
  [/(swap|exchange)/, Capability.PROTOCOL_DEX_SWAP],
  [/borrow/, Capability.PROTOCOL_LENDING_BORROW],
  [/repay/, Capability.PROTOCOL_LENDING_REPAY],
  [/(withdraw|redeem)/, Capability.PROTOCOL_LENDING_WITHDRAW],
  [/(supply|deposit|mint)/, Capability.PROTOCOL_LENDING_SUPPLY],
  [/transfer/, Capability.ASSET_TRANSFER_TOKEN],
];

/** The capability a write verb names, or null when none matches. */
export function capabilityForWriteVerb(text: string): Capability | null {
  const normalized = text.toLowerCase();
  for (const [pattern, capability] of WRITE_VERB_CAPABILITIES) {
    if (pattern.test(normalized)) {
      return capability;
    }
  }
  return null;
}
