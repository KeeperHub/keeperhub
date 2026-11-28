import { ETHEREUM_L1_CHAIN_IDS } from "@/lib/web3/ethereum-l1";
import { extractRevertData, rpcErrorOf } from "@/lib/web3/revert-data";

const GAS_LIMIT_TOO_LOW = "gas-limit-too-low" as const;
const GAS_LIMIT_TOO_HIGH = "gas-limit-too-high" as const;
const RAISE_OR_CLEAR = "Raise the Gas Limit or leave it empty.";

// Ethereum L1 caps a transaction at 2^24 gas (EIP-7825).
const EIP_7825_TX_GAS_CAP = BigInt(2 ** 24);
// Chains whose latest block may be a small one while big blocks also come (HyperEVM):
// their latest block's gas limit is not the per-transaction limit.
const MIXED_BLOCK_SIZE_CHAIN_IDS: ReadonlySet<number> = new Set([999, 998]);

// The node's own out-of-gas words. Only this, or revert data, counts as
// evidence that a limit is too low.
const OUT_OF_GAS_PATTERN =
  /out of gas|outofgas|\boog\b|reentrancysentryoog|intrinsic gas|gas required exceeds allowance/i;

/**
 * A fixed Gas Limit below what the call needs, found by a pre-send check:
 * nothing was sent and no nonce was used.
 */
export class GasLimitTooLowError extends Error {
  override readonly name = "GasLimitTooLowError" as const;
  readonly kind = GAS_LIMIT_TOO_LOW;
  readonly gasLimit: bigint;

  constructor(
    gasLimit: bigint,
    detail: { needs?: bigint; revertedWith?: string },
    options?: { cause?: unknown }
  ) {
    const reverted = detail.revertedWith
      ? `, reverting with ${detail.revertedWith},`
      : "";
    super(
      detail.needs === undefined
        ? `Gas Limit ${gasLimit} is too low for this call: the call fails under that limit${reverted} and passes without one. ${RAISE_OR_CLEAR}`
        : `Gas Limit ${gasLimit} is too low for this call, which needs about ${detail.needs} gas. ${RAISE_OR_CLEAR}`,
      options
    );
    this.gasLimit = gasLimit;
  }
}

/** A fixed Gas Limit above what the network accepts; nothing was sent. */
class GasLimitTooHighError extends Error {
  override readonly name = "GasLimitTooHighError" as const;
  readonly kind = GAS_LIMIT_TOO_HIGH;
  readonly gasLimit: bigint;
  // A pre-send verdict: the RPC failover must not retry it elsewhere.
  readonly nonRetryable = true;

  constructor(gasLimit: bigint, networkLimit: bigint) {
    super(
      `Gas Limit ${gasLimit} is above the network's limit of ${networkLimit}. Lower it or leave it empty.`
    );
    this.gasLimit = gasLimit;
  }
}

/** Either Gas Limit error: both come from a pre-send check. */
export function isGasLimitError(error: unknown): boolean {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return (
    error instanceof Error &&
    (kind === GAS_LIMIT_TOO_LOW || kind === GAS_LIMIT_TOO_HIGH)
  );
}

/**
 * The most gas one transaction may use here: the block gas limit where it is the
 * per-transaction limit, and 2^24 on Ethereum L1. Undefined when unknown.
 */
function networkGasLimit(
  chainId: number,
  blockGasLimit: bigint | undefined
): bigint | undefined {
  const cap = ETHEREUM_L1_CHAIN_IDS.has(chainId)
    ? EIP_7825_TX_GAS_CAP
    : undefined;
  // A missing or zero block gas limit says nothing.
  if (
    MIXED_BLOCK_SIZE_CHAIN_IDS.has(chainId) ||
    blockGasLimit === undefined ||
    blockGasLimit <= BigInt(0)
  ) {
    return cap;
  }
  return cap !== undefined && cap < blockGasLimit ? cap : blockGasLimit;
}

/** Refuses a fixed limit above the network's, decided by numbers alone. */
export function assertGasLimitFits(
  gasLimit: bigint,
  chainId: number,
  blockGasLimit: bigint | undefined
): void {
  const limit = networkGasLimit(chainId, blockGasLimit);
  if (limit !== undefined && gasLimit > limit) {
    throw new GasLimitTooHighError(gasLimit, limit);
  }
}

/** The node's own words on a failed call, as ethers keeps them. */
export function nodeMessageOf(error: unknown): string {
  const e = (error ?? {}) as { shortMessage?: unknown; message?: unknown };
  const text = rpcErrorOf(error)?.message ?? e.shortMessage ?? e.message;
  return typeof text === "string" ? text : "";
}

/** A capped failure that could be the limit: revert data or out-of-gas words. */
export function hasOutOfGasEvidence(error: unknown): boolean {
  const data = extractRevertData(error);
  return (
    (data !== undefined && data.length > 2) ||
    OUT_OF_GAS_PATTERN.test(nodeMessageOf(error))
  );
}
