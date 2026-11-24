import { ethers } from "ethers";

/** A call as nodes take it in eth_call / eth_estimateGas / eth_simulateV1. */
export function txForNode(
  from: string | undefined,
  call: { to: string; data: string; value?: bigint }
): Record<string, string> {
  const tx: Record<string, string> = { to: call.to, data: call.data };
  if (from) {
    tx.from = from;
  }
  if (call.value !== undefined && call.value > BigInt(0)) {
    tx.value = ethers.toQuantity(call.value);
  }
  return tx;
}

/** eth_simulateV1 params for one simulated block holding `calls`. */
export function simulateV1Params(
  calls: Record<string, string>[],
  block: {
    blockOverrides?: Record<string, string>;
    stateOverrides?: Record<string, { code: string }>;
  } = {},
  blockTag = "latest"
): unknown[] {
  return [
    {
      blockStateCalls: [{ ...block, calls }],
      // A dry run asks what the calls would do, not whether the wallet is
      // funded to send them.
      validation: false,
      traceTransfers: false,
    },
    blockTag,
  ];
}
