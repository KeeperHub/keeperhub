import { ethers } from "ethers";
import { logWarn } from "@/lib/logging";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { sleep } from "@/lib/sleep";
import { getErrorMessage } from "@/lib/utils";
import {
  isOnChainPendingError,
  OnChainPendingError,
  OnChainRevertError,
} from "@/lib/web3/onchain-revert";
import { submitSignedTransactionWithFailover } from "@/lib/web3/submit-signed";
import type { AdaptiveGasStrategy, GasConfig } from "../gas-strategy";
import type { NonceManager, NonceSession } from "../nonce-manager";
import { buildChainAddressUrl, buildChainTransactionUrl } from "./explorer";
import type {
  ChainAdapter,
  ContractCallRequest,
  ReadContractRequest,
  SendTransactionRequest,
  TransactionOptions,
  TransactionReceipt,
} from "./types";

// Tempo (4217 mainnet, 42431 Moderato testnet) settles native 0x76
// transactions whose RPC shape carries a null top level `value` and a `calls`
// array. ethers v6 `tx.wait()` arms replacement scanning that reads full
// transactions and blocks; its `formatTransactionResponse` throws BAD_DATA on
// that null `value`, so a mined Tempo tx is reported as failed. A receipt has
// no `value` or `calls` fields, so confirm by polling the receipt on Tempo.
const TEMPO_CHAIN_IDS = new Set<number>([4217, 42_431]);
const TEMPO_RECEIPT_TIMEOUT_MS = 60_000;
const TEMPO_RECEIPT_POLL_INTERVAL_MS = 1500;

export class EvmChainAdapter implements ChainAdapter {
  readonly chainFamily = "evm";
  private readonly chainId: number;
  private readonly gasStrategy: AdaptiveGasStrategy;
  private readonly nonceManager: NonceManager;

  constructor(
    chainId: number,
    gasStrategy: AdaptiveGasStrategy,
    nonceManager: NonceManager
  ) {
    this.chainId = chainId;
    this.gasStrategy = gasStrategy;
    this.nonceManager = nonceManager;
  }

  async sendTransaction(
    signer: ethers.Signer,
    request: SendTransactionRequest,
    session: NonceSession,
    options: TransactionOptions
  ): Promise<TransactionReceipt> {
    const provider = signer.provider;
    if (!provider) {
      throw new Error("Signer has no provider");
    }

    const walletAddress = await signer.getAddress();
    const baseTx: ethers.TransactionRequest = {
      to: request.to,
      value: request.value,
      data: request.data,
    };

    if (options.rpcManager) {
      await options.rpcManager.executeWithFailover(
        (rpcProvider) => rpcProvider.call({ ...baseTx, from: walletAddress }),
        "preflight"
      );
    } else {
      await provider.call({ ...baseTx, from: walletAddress });
    }

    const nonce = this.nonceManager.getNextNonce(session);

    const estimatedGas = options.rpcManager
      ? await options.rpcManager.executeWithFailover(
          (rpcProvider) =>
            rpcProvider.estimateGas({ ...baseTx, from: walletAddress }),
          "preflight"
        )
      : await provider.estimateGas({ ...baseTx, from: walletAddress });

    const gasConfig = await this.gasStrategy.getGasConfig(
      provider,
      estimatedGas,
      this.chainId,
      options.gasOverrides.multiplierOverride,
      options.gasOverrides.gasLimitOverride,
      options.rpcManager,
      options.gasOverrides.priorityFeeOverride
    );

    // KEEP-565: when an rpcManager is wired, broadcast through the
    // sign-once-and-failover helper so the actual broadcast survives a
    // primary-RPC blip between resolveActiveRpcUrl() and send. Signing
    // happens exactly once; helper reconciles on broadcast error
    // (already-known / nonce-too-low) by checking chain state before
    // re-throwing. Falls back to direct signer.sendTransaction when no
    // manager is provided (legacy callers; tracked by KEEP-548 for full
    // adoption).
    const txRequest = {
      ...baseTx,
      from: walletAddress,
      nonce,
      gasLimit: gasConfig.gasLimit,
      maxFeePerGas: gasConfig.maxFeePerGas,
      maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
      chainId: this.chainId,
    };
    const tx = options.rpcManager
      ? (
          await submitSignedTransactionWithFailover(
            signer,
            txRequest,
            options.rpcManager
          )
        ).response
      : await signer.sendTransaction(txRequest);

    return this.confirmTransaction(tx, session, nonce, gasConfig, options);
  }

  async executeContractCall(
    signer: ethers.Signer,
    request: ContractCallRequest,
    session: NonceSession,
    options: TransactionOptions
  ): Promise<TransactionReceipt> {
    const provider = signer.provider;
    if (!provider) {
      throw new Error("Signer has no provider");
    }

    let contract: ethers.Contract;
    try {
      contract = new ethers.Contract(
        request.contractAddress,
        request.abi,
        signer
      );
    } catch (error) {
      throw new Error(
        `Failed to create contract instance: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Use getFunction() so ABI names that collide with BaseContract built-ins
    // (e.g. getAddress, attach, connect, queryFilter) resolve to the ABI fragment
    // instead of the inherited method.
    const fn = contract.getFunction(request.functionKey);

    const signerAddress = await signer.getAddress();
    const callOverrides = {
      ...(request.value ? { value: request.value } : {}),
      from: signerAddress,
    };

    if (options.rpcManager) {
      await options.rpcManager.executeWithFailover((rpcProvider) => {
        const readContract = new ethers.Contract(
          request.contractAddress,
          request.abi,
          rpcProvider
        );
        return readContract
          .getFunction(request.functionKey)
          .staticCall(...request.args, callOverrides);
      }, "preflight");
    } else {
      await fn.staticCall(...request.args, callOverrides);
    }

    const nonce = this.nonceManager.getNextNonce(session);

    const estimatedGas = options.rpcManager
      ? await options.rpcManager.executeWithFailover((rpcProvider) => {
          const readContract = new ethers.Contract(
            request.contractAddress,
            request.abi,
            rpcProvider
          );
          return readContract
            .getFunction(request.functionKey)
            .estimateGas(...request.args, callOverrides);
        }, "preflight")
      : await fn.estimateGas(...request.args, callOverrides);

    const gasConfig = await this.gasStrategy.getGasConfig(
      provider,
      estimatedGas,
      this.chainId,
      options.gasOverrides.multiplierOverride,
      options.gasOverrides.gasLimitOverride,
      options.rpcManager,
      options.gasOverrides.priorityFeeOverride
    );

    // KEEP-565: route the broadcast through submitSignedTransactionWithFailover
    // when a manager is available. We encode the calldata via the contract's
    // own Interface and pass an explicit TransactionRequest -- the helper
    // populates / signs / broadcasts with failover and reconciles on error.
    // Direct `fn(...)` call kept as fallback for callers without an
    // rpcManager (legacy code paths; tracked by KEEP-548).
    let tx: ethers.TransactionResponse;
    if (options.rpcManager) {
      const calldata = contract.interface.encodeFunctionData(
        request.functionKey,
        request.args
      );
      const txRequest = {
        to: request.contractAddress,
        data: calldata,
        from: signerAddress,
        nonce,
        gasLimit: gasConfig.gasLimit,
        maxFeePerGas: gasConfig.maxFeePerGas,
        maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
        chainId: this.chainId,
        ...(request.value ? { value: request.value } : {}),
      };
      const broadcast = await submitSignedTransactionWithFailover(
        signer,
        txRequest,
        options.rpcManager
      );
      tx = broadcast.response;
    } else {
      tx = await fn(...request.args, {
        nonce,
        gasLimit: gasConfig.gasLimit,
        maxFeePerGas: gasConfig.maxFeePerGas,
        maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
        ...(request.value ? { value: request.value } : {}),
      });
    }

    return this.confirmTransaction(tx, session, nonce, gasConfig, options);
  }

  async readContract(
    rpcManager: RpcProviderManager,
    request: ReadContractRequest
  ): Promise<unknown> {
    return await rpcManager.executeWithFailover(async (provider) => {
      const contract = new ethers.Contract(
        request.contractAddress,
        request.abi,
        provider
      );

      // Use getFunction() so ABI names that collide with BaseContract built-ins
      // (e.g. getAddress, attach, connect, queryFilter) resolve to the ABI
      // fragment instead of the inherited method.
      const fn = contract.getFunction(request.functionKey);

      return request.isView
        ? await fn(...request.args)
        : await fn.staticCall(...request.args);
    });
  }

  async getBalance(
    rpcManager: RpcProviderManager | undefined,
    address: string
  ): Promise<bigint> {
    if (!rpcManager) {
      throw new Error("[EvmChainAdapter] getBalance requires an rpcManager");
    }
    return await rpcManager.executeWithFailover(async (provider) =>
      provider.getBalance(address)
    );
  }

  async executeWithFailover<T>(
    rpcManager: RpcProviderManager,
    operation: (provider: ethers.JsonRpcProvider) => Promise<T>,
    operationType?: "read" | "write"
  ): Promise<T> {
    return await rpcManager.executeWithFailover(operation, operationType);
  }

  // The explorer URL is cosmetic. A failure building it (e.g. the explorer-config
  // lookup throwing) must never propagate: transfer steps call this after the
  // transaction is already mined, inside the try/catch that maps a throw to a
  // failed result, so a throw here would report a completed transfer as failed.
  async getTransactionUrl(txHash: string): Promise<string> {
    try {
      return await buildChainTransactionUrl(this.chainId, txHash);
    } catch (error) {
      logWarn(
        `[EvmChainAdapter] Failed to build transaction explorer URL: ${getErrorMessage(error)}`,
        { chain_id: String(this.chainId) }
      );
      return "";
    }
  }

  async getAddressUrl(address: string): Promise<string> {
    try {
      return await buildChainAddressUrl(this.chainId, address);
    } catch (error) {
      logWarn(
        `[EvmChainAdapter] Failed to build address explorer URL: ${getErrorMessage(error)}`,
        { chain_id: String(this.chainId) }
      );
      return "";
    }
  }

  // Confirm by polling the receipt directly by hash instead of ethers
  // `tx.wait()`. Used on Tempo, where wait()'s replacement scan parses full
  // 0x76 transactions and throws BAD_DATA on their null `value`, failing an
  // already mined tx. Prefers the rpcManager (failover) and falls back to the
  // response's own provider for legacy callers.
  private async waitForReceiptByHash(
    tx: ethers.TransactionResponse,
    options: TransactionOptions
  ): Promise<ethers.TransactionReceipt> {
    const { rpcManager } = options;
    const provider = tx.provider;
    const fetchReceipt = (): Promise<ethers.TransactionReceipt | null> => {
      if (rpcManager) {
        return rpcManager.executeWithFailover(
          (p) => p.getTransactionReceipt(tx.hash),
          "read"
        );
      }
      if (!provider) {
        throw new Error("Transaction has no provider to poll for a receipt");
      }
      return provider.getTransactionReceipt(tx.hash);
    };

    const deadline = Date.now() + TEMPO_RECEIPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const receipt = await fetchReceipt();
      if (receipt) {
        return receipt;
      }
      await sleep(TEMPO_RECEIPT_POLL_INTERVAL_MS);
    }
    // The poll ran out of time, but the transaction is on the network: the
    // same unknown-not-failed case as an empty receipt in confirmTransaction
    // below. The hash rides on the error rather than living only in the
    // message text, so the finalizer can settle the row as `unconfirmed` and
    // hand it to the reconciler.
    throw new OnChainPendingError({
      message: `Timed out waiting for Tempo transaction receipt (${tx.hash})`,
      transactionHash: tx.hash,
    });
  }

  // Confirm through ethers `tx.wait()`, converting its post-broadcast throws
  // into the carriers the finalizer understands (#2177).
  //
  // `tx.wait()` with no argument runs at confirms = 1, and at that setting
  // ethers never resolves null: it returns a receipt, keeps waiting, or throws.
  // So the genuine "broadcast, outcome unreadable" cases on this path arrive as
  // throws, and an unclassified throw loses the hash: the row is stamped
  // terminally failed with a null transaction_hash, outside the reconciler
  // scan. That is #2020, on the path that carries most traffic.
  private async waitForReceiptViaEthers(
    tx: ethers.TransactionResponse
  ): Promise<ethers.TransactionReceipt> {
    try {
      const receipt = await tx.wait();
      if (receipt) {
        return receipt;
      }
      // Unreachable against real ethers at confirms = 1; kept because the
      // declared type allows null and an explicit wait(0) caller could reach it.
      throw new OnChainPendingError({
        message: "Transaction sent but receipt not available",
        transactionHash: tx.hash,
      });
    } catch (error) {
      // The module's own duck-typed guard, not `instanceof`: onchain-revert is
      // `server-only` and can be instantiated in more than one module registry,
      // where the classes are distinct and `instanceof` silently misses.
      if (isOnChainPendingError(error)) {
        throw error;
      }
      const code = (error as { code?: string } | null)?.code;

      // A detected revert is a SETTLED failure, not an unknown one, so it goes
      // to the revert path: the row is closed rather than left to reconcile.
      if (code === "CALL_EXCEPTION") {
        const reverted = (error as { receipt?: ethers.TransactionReceipt })
          .receipt;
        throw new OnChainRevertError({
          message: `Transaction ${reverted?.hash ?? tx.hash} reverted on-chain (${getErrorMessage(error)})`,
          transactionHash: reverted?.hash ?? tx.hash,
          blockNumber: reverted?.blockNumber,
        });
      }

      if (code === "TRANSACTION_REPLACED") {
        const replaced = error as {
          cancelled?: boolean;
          reason?: string;
          receipt?: ethers.TransactionReceipt;
        };
        // `cancelled` is mechanical in ethers (provider.ts): it is true for
        // reason "replaced" or "cancelled", false for "repriced".
        //
        // repriced: same work, same nonce, higher fee. The replacement receipt
        // IS our result, so fall through to the normal status checks instead of
        // failing. The hash worth recording is the replacement one — the
        // original hash will never confirm, and a row carrying it could never
        // be resolved by any scan.
        if (replaced.cancelled === false && replaced.receipt) {
          return replaced.receipt;
        }
        // replaced / cancelled: our transaction was not executed and never will
        // be, because the nonce is spent by something else. That is conclusive,
        // not unknown. Routing it to pending would create a row the reconciler
        // can never close — #2020 entered from the other end.
        //
        // The hash on the error stays OURS. The replacement is a transaction
        // we did not send and it usually succeeded, so recording its hash
        // would let the finalizer re-verify a stranger's receipt: `verified:
        // true` off the status alone, and the reconciler settles this
        // execution `completed`.
        // The replacement hash belongs in the message, where it still tells
        // whoever reads the row which transaction took the nonce, and `reason`
        // stays there too because "cancelled" and "replaced" mean different
        // things to that reader.
        //
        // Only an explicit `cancelled` is conclusive. An absent one is a shape
        // we do not recognise, and unknown shapes take the pending default
        // below for the same reason unknown codes do.
        if (typeof replaced.cancelled === "boolean") {
          const landed = replaced.receipt?.hash ?? tx.hash;
          throw new OnChainRevertError({
            message: `Transaction ${tx.hash} was ${replaced.reason ?? "replaced"} by ${landed}; its effects cannot be assured`,
            transactionHash: tx.hash,
            blockNumber: replaced.receipt?.blockNumber,
          });
        }
      }

      // Everything else — provider, network, TIMEOUT, BAD_DATA out of the
      // receipt read or the block listener — is genuinely unknown.
      //
      // Unknown CODES default here too, deliberately: if a future ethers
      // version adds a code we do not classify, treating it as terminal
      // re-creates #2020 for that code, while treating it as pending costs
      // only a row the reconciler resolves. Cheap in one direction, expensive
      // in the other.
      throw new OnChainPendingError({
        message: `Transaction sent but receipt could not be read (${getErrorMessage(error)})`,
        transactionHash: tx.hash,
      });
    }
  }

  private async confirmTransaction(
    tx: ethers.TransactionResponse,
    session: NonceSession,
    nonce: number,
    gasConfig: GasConfig,
    options: TransactionOptions
  ): Promise<TransactionReceipt> {
    await this.nonceManager.recordTransaction(
      session,
      nonce,
      tx.hash,
      options.workflowId,
      gasConfig.maxFeePerGas.toString()
    );

    const receipt = TEMPO_CHAIN_IDS.has(this.chainId)
      ? await this.waitForReceiptByHash(tx, options)
      : await this.waitForReceiptViaEthers(tx);
    if (!receipt) {
      // The transaction is on the network -- the nonce manager was handed its
      // hash a few lines above -- we simply could not read its outcome. That is
      // unknown, not failed, so the hash rides on the error: the finalizer
      // re-verifies it, settles the row as `unconfirmed`, and the reconciler
      // keeps watching until the chain answers. Throwing a bare Error here
      // dropped the hash and stamped a terminal failure for a transaction that
      // existed on-chain and nowhere in our data.
      throw new OnChainPendingError({
        message: "Transaction sent but receipt not available",
        transactionHash: tx.hash,
      });
    }
    // ethers v6 wait() throws CALL_EXCEPTION on reverts it can detect, but
    // that detection is provider-dependent; a tx that passed the staticCall
    // preflight and reverted only at inclusion time can still resolve here.
    // status 0 is authoritative: never report a reverted tx as confirmed.
    if (receipt.status === 0) {
      throw new OnChainRevertError({
        message: `Transaction ${receipt.hash} reverted on-chain (status 0, block ${receipt.blockNumber})`,
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      });
    }

    await this.nonceManager.confirmTransaction(tx.hash);

    return {
      hash: receipt.hash,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
      blockNumber: receipt.blockNumber,
    };
  }
}
