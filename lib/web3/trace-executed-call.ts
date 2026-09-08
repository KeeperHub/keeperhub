/**
 * Shared helper that resolves the normalized executed call for a just-sent
 * transaction, with RPC failover.
 *
 * Web3 write actions (write-contract, approve-token, transfer-token, ...) all
 * face the same problem: a gas-sponsored send routes through a relayer/wrapper,
 * so the on-chain transaction's top-level `to`/calldata no longer describe the
 * action that ran. This helper traces the transaction and decodes the actual
 * call against the target contract's ABI, so every action can attach a
 * consistent "what executed" view regardless of sponsorship.
 *
 * It is intentionally best-effort: when tracing is unavailable (RPC without
 * `debug_traceTransaction`, or no matching call found) it resolves to
 * `undefined` so callers degrade gracefully instead of failing the action.
 */
import "server-only";

import { ethers } from "ethers";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  type ExecutedCall,
  resolveExecutedCall,
  type TraceProvider,
} from "@/lib/web3/trace-decode";

export type TraceExecutedCallOptions = {
  /** Address whose call we want to recover (the action's target contract). */
  target: string;
  /** ABI used to decode the call (array or JSON string). */
  abi: unknown;
  /** Restrict to a specific function name. */
  functionName?: string;
  /** Positional argument filter; "" entries are wildcards. */
  filterArgs?: string[] | null;
};

function buildInterface(abi: unknown): ethers.Interface | null {
  try {
    return new ethers.Interface(abi as ethers.InterfaceAbi);
  } catch {
    return null;
  }
}

export async function traceExecutedCallWithFailover(
  rpcManager: RpcProviderManager,
  txHash: string,
  options: TraceExecutedCallOptions
): Promise<ExecutedCall | undefined> {
  const iface = buildInterface(options.abi);
  if (!iface) {
    return;
  }

  try {
    const executed = await rpcManager.executeWithFailover(async (provider) => {
      const result = await resolveExecutedCall(
        provider as unknown as TraceProvider,
        txHash,
        {
          target: options.target,
          iface,
          functionName: options.functionName,
          filterArgs: options.filterArgs ?? null,
        }
      );
      // resolveExecutedCall returns null when the provider doesn't support
      // debug_traceTransaction or when no matching call is found. Throwing here
      // lets executeWithFailover retry the next provider rather than treating
      // null as a successful empty result and stopping immediately.
      if (result === null) {
        throw new Error("trace unavailable");
      }
      return result;
    });
    return executed ?? undefined;
  } catch {
    return;
  }
}
