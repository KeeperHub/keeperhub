import "server-only";

import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import {
  RpcPurpose,
  RpcRouteError,
  type RpcStepInput,
  rpc,
  rpcScopeFromStep,
} from "@/lib/rpc/engine";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { isSolanaChain } from "@/lib/rpc/solana-chains";

/**
 * Native cost, in wei, of the transaction that fired an on-chain trigger.
 *
 * The keeper did not send that transaction, so this is deliberately kept apart
 * from the gas the run itself spent: the executor reports it under
 * `triggerGasUsed` rather than `gasUsed`, which is the key every gas rollup
 * reads (lib/workflow/executor/logging.ts resolveGasTotal, the runs
 * aggregation, and the Gas by Network breakdown). Counting it there would
 * report a third party's spend as the organization's own, and the Gas Spent
 * KPI derives the wallet share by subtracting the sponsorship ledger from that
 * total, so it would skew the split as well.
 *
 * Best-effort: a chain we cannot reach, a Solana trigger, or a receipt that has
 * not propagated yields null and the trigger simply reports no gas.
 */
export async function fetchTriggerTransactionGas(
  transactionHash: string,
  network: string | number,
  rpcInput: RpcStepInput
): Promise<string | null> {
  "use step";

  try {
    const chainId = getChainIdFromNetwork(network);
    if (isSolanaChain(chainId)) {
      return null;
    }

    const { manager } = await rpc.evm(rpcScopeFromStep(rpcInput), chainId, {
      purpose: RpcPurpose.READ,
    });
    const receipt = await manager.executeWithFailover(
      (provider) => provider.getTransactionReceipt(transactionHash),
      "read"
    );
    if (!receipt) {
      return null;
    }

    // ethers exposes the total fee (gasUsed * gasPrice) directly, in wei,
    // which is the same figure the write steps record as their own gasUsed.
    return receipt.fee.toString();
  } catch (error) {
    if (error instanceof RpcRouteError) {
      return null;
    }
    logSystemWarn(
      ErrorCategory.NETWORK_RPC,
      "[Trigger Gas] Could not read the receipt for the triggering transaction",
      error,
      { transaction_hash: transactionHash }
    );
    return null;
  }
}

fetchTriggerTransactionGas.maxRetries = 0;
