/**
 * Shared Tempo transaction core.
 *
 * Builds, signs, and broadcasts native Tempo type-0x76 transactions from the
 * organization's Turnkey-backed EOA. This is the extraction the plugins/tempo
 * steps build on.
 *
 * This file must NOT contain "use step" -- it is a core module so step files
 * can share it without the bundler pulling its transitive deps into the
 * workflow runtime.
 *
 * Signing model: Turnkey signs the raw 32-byte envelope hash via
 * `signRawPayload` (PAYLOAD_ENCODING_HEXADECIMAL + HASH_FUNCTION_NO_OP), the
 * same primitive the production MPP charge path uses on Tempo. Tempo's
 * SignatureEnvelope takes the raw yParity bit (0 | 1), NOT Ethereum's v+27.
 *
 * Fee model: no gas token. Fees are paid in a TIP-20 stablecoin set via the
 * envelope's `feeToken` field, drawn from the wallet's own balance. Turnkey
 * Gas Station sponsorship does not cover Tempo, so there is no sponsored path
 * here -- the wallet pays its own fees. Gas limit and fee prices come from the
 * shared AdaptiveGasStrategy (per-call eth_estimateGas times the chain
 * multiplier for the limit; live feeHistory for the prices), not constants.
 *
 * Nonce model: a persistent 2D nonce read from the nonce-manager precompile.
 * The TIP-1009 expiring-nonce marker used by the sponsored MPP path is only
 * honored when a fee-payer co-signs, so it cannot be used here.
 */
import "server-only";

import { ethers } from "ethers";
import { TxEnvelopeTempo } from "ox/tempo";
import { encodeFunctionData, type Hex, toFunctionSelector } from "viem";
import { Abis } from "viem/tempo";
import { toChecksumAddress } from "@/lib/address-utils";
import { checkStablecoinCalldataBatch } from "@/lib/execute/stablecoin-cap";
import { isFundingShortfall } from "@/lib/errors/funding-shortfall";
import { ErrorCategory, logSystemError, logUserError } from "@/lib/logging";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import { resolveSignerMode, SIGNER_MODE } from "@/lib/safe/signer-resolver";
import { getTurnkeySignerConfig } from "@/lib/turnkey/turnkey-client";
import { getGasStrategy } from "@/lib/web3/gas-strategy";
import { getOrganizationWallet } from "@/lib/web3/wallet-helpers";

/** Tempo nonce-manager precompile (viem/tempo Addresses.nonceManager). */
const TEMPO_NONCE_MANAGER = "0x4e4F4E4345000000000000000000000000000000";

/** Tempo enshrined stablecoin DEX precompile (viem/tempo Addresses.stablecoinDex). */
export const TEMPO_STABLECOIN_DEX =
  "0xdec0000000000000000000000000000000000000" as const;

const NONCE_ABI = [
  "function getNonce(address account, uint256 nonceKey) view returns (uint64)",
] as const;
const nonceInterface = new ethers.Interface(NONCE_ABI);

const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);

/**
 * Derive a unique 2D-nonce lane for a single send. Tempo's nonce manager keeps
 * an independent sequence per (account, key), so giving every broadcast its own
 * key removes the read-then-sign race: two concurrent sends from one wallet
 * never share a lane, so neither reads a nonce the other is about to consume.
 *
 * The key is namespaced under a KeeperHub-specific prefix and salted with random
 * bytes, so it stays unique even when two sends share an execution (parallel
 * branches) or carry no execution id. The execution id is folded in only so a
 * lane traces back to its run in logs. The result is mapped into
 * [1, MAX_UINT256 - 1] to stay off lane 0 (the protocol nonce) and the
 * max-uint256 expiring-marker lane.
 */
export function deriveTempoNonceKey(executionId: string | undefined): bigint {
  const salt = ethers.hexlify(ethers.randomBytes(16));
  const raw = BigInt(
    ethers.keccak256(
      ethers.toUtf8Bytes(
        `keeperhub:tempo:nonce-lane:v2:${executionId ?? "adhoc"}:${salt}`
      )
    )
  );
  return (raw % (MAX_UINT256 - BigInt(1))) + BigInt(1);
}

const RECEIPT_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_INTERVAL_MS = 1500;

const TEMPO_CHAIN_IDS = new Set([4217, 42_431]);

/** A pre-hashed bytes32 memo passed verbatim (0x + 64 hex chars). */
const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/;

export type TempoCall = { to: Hex; data: Hex };

type TurnkeySignature = { r: string; s: string; v: string };

type TurnkeyActivityResponse = {
  activity?: {
    status?: string;
    result?: { signRawPayloadResult?: TurnkeySignature };
  };
};

export type SignAndBroadcastParams = {
  organizationId: string;
  userId?: string;
  chainId: number;
  calls: TempoCall[];
  /** TIP-20 stablecoin the fee is drawn from (usually the transferred token). */
  feeToken: Hex;
  /** Optional native on-chain validity window (unix seconds): earliest and
   *  latest the tx may settle. `validBefore` acts as an expiry. */
  validAfter?: number;
  validBefore?: number;
  /** Execution id, folded into the per-send nonce lane for traceability. */
  executionId?: string;
};

export type SignAndBroadcastResult = { hash: string; from: string };

export type SignTempoTxParams = SignAndBroadcastParams & {
  /**
   * Multiply the adaptive `maxFeePerGas` ceiling for headroom. A held payment is
   * signed now but broadcast later, so it over-provisions the ceiling to survive
   * a base-fee rise between signing and broadcast. `maxFeePerGas` is a ceiling,
   * not the fee paid, so over-provisioning is safe.
   */
  maxFeePerGasMultiplier?: number;
  /** Floor for `maxFeePerGas` (wei), applied after the multiplier, so an
   *  anomalously low adaptive read still yields a usable ceiling. */
  maxFeePerGasFloor?: bigint;
};

/** A signed-but-not-broadcast Tempo transaction plus the fields needed to hold,
 *  display, and later broadcast it. `serialized` is the self-contained 0x76
 *  blob; broadcasting it needs no further signing. */
export type SignedTempoTx = {
  serialized: string;
  hash: string;
  from: string;
  chainId: number;
  nonceKey: bigint;
  nonce: bigint;
  maxFeePerGas: bigint;
  validAfter?: number;
  validBefore?: number;
};

export type BroadcastStoredTempoTxParams = {
  chainId: number;
  userId?: string;
  /** The self-contained 0x76 blob from `signTempoTx` or a stored held payment. */
  serialized: string;
  /** When set, refuse to broadcast unless the blob still hashes to this value. */
  expectedHash?: string;
  /** When false, return as soon as the node accepts the tx (poller path). */
  waitForConfirmation?: boolean;
};

export type BroadcastStoredTempoTxResult = { hash: string; confirmed: boolean };

export function isTempoChain(chainId: number): boolean {
  return TEMPO_CHAIN_IDS.has(chainId);
}

/**
 * Encode a TIP-20 `transferWithMemo(to, value, memo)` call for one batch entry.
 */
export function buildTransferWithMemoCall(
  token: Hex,
  recipient: Hex,
  amountRaw: bigint,
  memo: Hex
): TempoCall {
  const data = encodeFunctionData({
    abi: Abis.tip20,
    functionName: "transferWithMemo",
    args: [recipient, amountRaw, memo],
  });
  return { to: token, data };
}

/**
 * Encode a `swapExactAmountIn(tokenIn, tokenOut, amountIn, minAmountOut)` call
 * against the enshrined stablecoin DEX precompile. The DEX pulls tokenIn from
 * the wallet and settles tokenOut back to it (hybrid balance model), so this is
 * a single call with no approve/deposit; the swap reverts if the output would
 * fall below `minAmountOut`.
 */
export function buildSwapExactAmountInCall(
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  minAmountOut: bigint
): TempoCall {
  const data = encodeFunctionData({
    abi: Abis.stablecoinDex,
    functionName: "swapExactAmountIn",
    args: [tokenIn, tokenOut, amountIn, minAmountOut],
  });
  return { to: TEMPO_STABLECOIN_DEX, data };
}

/**
 * Normalize a user-supplied memo into a bytes32 value. A 0x-prefixed 32-byte
 * hex string is used verbatim (e.g. a receipt hash); any other string is
 * utf8-encoded and right-padded to 32 bytes so short invoice / pay-run refs
 * land as an indexed topic the payment-received trigger can filter on.
 */
export function normalizeMemo(memo?: string): Hex {
  if (!memo || memo.trim() === "") {
    return `0x${"0".repeat(64)}`;
  }
  const trimmed = memo.trim();
  if (BYTES32_HEX.test(trimmed)) {
    return trimmed as Hex;
  }
  // Right-padded utf8 (Solidity bytes32-string convention) so the payer and the
  // payment-received trigger derive the same indexed topic. Caps at 31 bytes.
  try {
    return ethers.encodeBytes32String(trimmed) as Hex;
  } catch {
    throw new Error(
      `Memo "${trimmed}" is too long: a plain-text memo must be 31 bytes or fewer, or pass a 0x + 64-hex bytes32 value.`
    );
  }
}

const TRANSFER_WITH_MEMO_SELECTOR = toFunctionSelector(
  "transferWithMemo(address,uint256,bytes32)"
);

/**
 * Floor for a memo transfer's estimate. eth_estimateGas on Tempo reports the
 * storage cost of the bytes32 memo write too low, so a memo transfer's estimate
 * (~35k) can land far below its real settlement cost (~272k) and the node
 * rejects the tx ("call gas cost exceeds the gas limit"). Raising the limit is
 * free on Tempo (the fee is charged on gas used, not the limit), so flooring is
 * safe and applies to each memo call.
 */
export const TEMPO_MEMO_MIN_GAS = BigInt(300_000);

/** Raise a memo transfer's estimate to the memo floor; other calls unchanged. */
export function applyTempoMemoGasFloor(
  call: TempoCall,
  estimatedGas: bigint
): bigint {
  const isMemoTransfer = call.data
    .toLowerCase()
    .startsWith(TRANSFER_WITH_MEMO_SELECTOR);
  if (isMemoTransfer && estimatedGas < TEMPO_MEMO_MIN_GAS) {
    return TEMPO_MEMO_MIN_GAS;
  }
  return estimatedGas;
}

/**
 * Estimate execution gas for the batch by summing per-call estimates. The
 * atomic 0x76 envelope is not directly estimable via eth_estimateGas, so each
 * call is estimated as a standalone call from the wallet; summing slightly
 * over-counts the shared intrinsic cost, which is safe (on Tempo the fee is
 * charged on gas used, not the limit). Memo transfers are floored because their
 * estimate omits the memo storage cost. The AdaptiveGasStrategy multiplier then
 * adds the safety margin on top.
 */
async function estimateTempoGas(
  rpcManager: RpcProviderManager,
  from: string,
  calls: TempoCall[]
): Promise<bigint> {
  let total = BigInt(0);
  for (const call of calls) {
    const gas = await rpcManager.executeWithFailover(
      (provider) =>
        provider.estimateGas({ from, to: call.to, data: call.data }),
      "preflight"
    );
    total += applyTempoMemoGasFloor(call, gas);
  }
  return total;
}

async function readTempoNonce(
  rpcManager: RpcProviderManager,
  account: string,
  nonceKey: bigint
): Promise<bigint> {
  const data = nonceInterface.encodeFunctionData("getNonce", [
    account,
    nonceKey,
  ]);
  const raw = await rpcManager.executeWithFailover((provider) =>
    provider.call({ to: TEMPO_NONCE_MANAGER, data })
  );
  const [nonce] = nonceInterface.decodeFunctionResult("getNonce", raw);
  return BigInt(nonce);
}

async function signEnvelopeHash(
  subOrgId: string,
  signWith: string,
  hexHash: string
): Promise<TurnkeySignature> {
  const { client } = getTurnkeySignerConfig(subOrgId, signWith);
  const response = (await (
    client as unknown as {
      signRawPayload: (args: unknown) => Promise<TurnkeyActivityResponse>;
    }
  ).signRawPayload({
    signWith,
    payload: hexHash,
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
    hashFunction: "HASH_FUNCTION_NO_OP",
  })) as TurnkeyActivityResponse;

  const status = response?.activity?.status;
  if (status !== "ACTIVITY_STATUS_COMPLETED") {
    throw new Error(`Turnkey returned status ${status ?? "unknown"}`);
  }
  const result = response?.activity?.result?.signRawPayloadResult;
  if (!result) {
    throw new Error("Signature missing from Turnkey response");
  }
  return result;
}

/**
 * Convert a Turnkey `{r, s, v}` triple into a Tempo secp256k1 signature
 * envelope. Tempo takes the raw yParity bit (0 | 1), NOT Ethereum's v+27, so
 * this must not reuse the @turnkey/ethers serializer.
 */
function toSignatureEnvelope(sig: TurnkeySignature): {
  type: "secp256k1";
  signature: { r: bigint; s: bigint; yParity: 0 | 1 };
} {
  const yParity = Number.parseInt(sig.v, 16);
  if (yParity !== 0 && yParity !== 1) {
    throw new Error(
      `Turnkey returned unexpected v-parity "${sig.v}" (expected 00 or 01)`
    );
  }
  return {
    type: "secp256k1",
    signature: {
      r: BigInt(`0x${sig.r}`),
      s: BigInt(`0x${sig.s}`),
      yParity: yParity as 0 | 1,
    },
  };
}

/**
 * Widen the adaptive `maxFeePerGas` ceiling for a held payment: scale it by the
 * multiplier, then floor it. `maxFeePerGas` is a ceiling, not the fee paid, so a
 * generous value only guards against a later base-fee rise. The multiplier is
 * taken to two decimals to stay in bigint math.
 */
function applyFeeHeadroom(
  base: bigint,
  multiplier?: number,
  floor?: bigint
): bigint {
  let ceiling = base;
  if (multiplier && multiplier > 1) {
    ceiling = (ceiling * BigInt(Math.round(multiplier * 100))) / BigInt(100);
  }
  if (floor && floor > ceiling) {
    ceiling = floor;
  }
  return ceiling;
}

async function waitForReceipt(
  rpcManager: RpcProviderManager,
  hash: string
): Promise<ethers.TransactionReceipt> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await rpcManager.executeWithFailover((provider) =>
      provider.getTransactionReceipt(hash)
    );
    if (receipt) {
      return receipt;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, RECEIPT_POLL_INTERVAL_MS)
    );
  }
  throw new Error(`Timed out waiting for Tempo transaction receipt (${hash})`);
}

/**
 * Build and sign one Tempo 0x76 transaction carrying `calls`, WITHOUT
 * broadcasting it. Resolves the org's Turnkey EOA, enforces EOA-only signing
 * (Safe is unsupported on Tempo), reads a fresh 2D-nonce lane, and signs the
 * envelope hash via Turnkey. Returns the self-contained serialized blob plus
 * the fields a held payment needs to display and later broadcast it.
 *
 * A signed Tempo envelope is self-contained: broadcasting it later needs no
 * further signing. The `validBefore` window (when set) is the on-chain safety
 * expiry, so the tx can never settle outside its intended window even if the
 * broadcast is deferred.
 */
export async function signTempoTx(
  params: SignTempoTxParams
): Promise<SignedTempoTx> {
  const { organizationId, userId, chainId, calls, feeToken } = params;

  if (!isTempoChain(chainId)) {
    throw new Error(`Chain ${chainId} is not a Tempo network`);
  }
  if (calls.length === 0) {
    throw new Error("Tempo transaction must contain at least one call");
  }

  const signerMode = await resolveSignerMode(organizationId, chainId);
  if (signerMode.kind !== SIGNER_MODE.EOA) {
    throw new Error(
      "Tempo transactions require an EOA wallet. Safe accounts are not supported on Tempo; disable Safe mode for this workflow."
    );
  }

  // Stablecoin ceiling. Tempo moves TIP-20 stablecoins as its primary asset and
  // carries no native value at all, so the daily value cap never sees a Tempo
  // send. Every Tempo write is signed here, so one check covers transfer-with-
  // memo, batch payouts, held payments and swaps.
  // Batched, not per call. signTempoTx carries every call of a batch payout in
  // one 0x76 transaction, so checking each in isolation let ten entries of 99
  // USD each clear a 100 USD ceiling while the transaction moved 990 USD, with
  // nothing bounding the entry count.
  const stablecoinDecision = await checkStablecoinCalldataBatch({
    organizationId,
    chainId,
    context: "tempo",
    calls,
  });
  if (stablecoinDecision.kind !== "allowed") {
    throw new Error(stablecoinDecision.error);
  }

  const wallet = await getOrganizationWallet(organizationId);
  if (!wallet.turnkeySubOrgId) {
    throw new Error("Organization wallet is missing its Turnkey sub-org id");
  }
  const from = toChecksumAddress(wallet.walletAddress);

  // A fresh lane per send: concurrent sends from this wallet never share a
  // 2D-nonce sequence, so the read below cannot return a nonce another send is
  // about to consume.
  const nonceKey = deriveTempoNonceKey(params.executionId);

  const rpcManager = await getRpcProvider({ chainId, userId });
  const [nonce, estimatedGas] = await Promise.all([
    readTempoNonce(rpcManager, from, nonceKey),
    estimateTempoGas(rpcManager, from, calls),
  ]);

  // Gas limit (estimate x chain multiplier) and EIP-1559 fee prices come from
  // the shared adaptive strategy, so Tempo tracks live network state the same
  // way every other EVM write step does.
  const gasConfig = await getGasStrategy().getGasConfig(
    rpcManager.getProvider(),
    estimatedGas,
    chainId,
    undefined,
    undefined,
    rpcManager
  );

  // maxFeePerGas is a ceiling, not the fee paid. A held payment broadcast later
  // widens the ceiling (adaptive x multiplier, floored) so it survives a
  // base-fee rise; an immediate send passes neither and keeps adaptive pricing.
  const maxFeePerGas = applyFeeHeadroom(
    gasConfig.maxFeePerGas,
    params.maxFeePerGasMultiplier,
    params.maxFeePerGasFloor
  );

  const envelope = TxEnvelopeTempo.from({
    chainId,
    calls: calls.map((c) => ({ to: c.to, data: c.data })),
    nonce,
    nonceKey,
    feeToken,
    gas: gasConfig.gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas,
    validAfter: params.validAfter,
    validBefore: params.validBefore,
  });

  const sighash = TxEnvelopeTempo.getSignPayload(envelope);
  const sig = await signEnvelopeHash(wallet.turnkeySubOrgId, from, sighash);
  const signed = TxEnvelopeTempo.from(envelope, {
    signature: toSignatureEnvelope(sig),
  });
  const serialized = TxEnvelopeTempo.serialize(signed);
  const hash = TxEnvelopeTempo.hash(signed);

  return {
    serialized,
    hash,
    from,
    chainId,
    nonceKey,
    nonce,
    maxFeePerGas,
    validAfter: params.validAfter,
    validBefore: params.validBefore,
  };
}

/**
 * Broadcast a previously-signed Tempo 0x76 blob and (by default) wait for a
 * successful receipt. Deserializes first to enforce the on-chain validity
 * window before spending an RPC round-trip, and to verify the blob still hashes
 * to `expectedHash` when supplied. With `waitForConfirmation:false` it returns
 * as soon as the node accepts the tx, so a scheduled poller can reconcile the
 * receipt on a later tick.
 */
export async function broadcastStoredTempoTx(
  params: BroadcastStoredTempoTxParams
): Promise<BroadcastStoredTempoTxResult> {
  const { chainId, userId, serialized, expectedHash } = params;
  const waitForConfirmation = params.waitForConfirmation ?? true;

  if (!isTempoChain(chainId)) {
    throw new Error(`Chain ${chainId} is not a Tempo network`);
  }

  const envelope = TxEnvelopeTempo.deserialize(
    serialized as TxEnvelopeTempo.Serialized
  );
  if (envelope.validBefore !== undefined) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (envelope.validBefore <= nowSec) {
      throw new Error(
        `This Tempo payment's validity window closed at ${new Date(
          envelope.validBefore * 1000
        ).toISOString()}; it can no longer be broadcast.`
      );
    }
  }
  if (expectedHash) {
    const actual = TxEnvelopeTempo.hash(envelope as TxEnvelopeTempo.Signed);
    if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error(
        "Stored Tempo transaction does not match its expected hash; refusing to broadcast."
      );
    }
  }

  const rpcManager = await getRpcProvider({ chainId, userId });
  let hash: string;
  try {
    hash = await rpcManager.executeWithFailover((provider) =>
      provider.send("eth_sendRawTransaction", [serialized])
    );
  } catch (error) {
    // A node that refuses the envelope because the payer cannot cover it is
    // answering about this wallet, not reporting that Tempo is unreachable.
    const message = error instanceof Error ? error.message : String(error);
    const log = isFundingShortfall(message) ? logUserError : logSystemError;
    log(
      ErrorCategory.TRANSACTION,
      "[Tempo] Failed to broadcast transaction",
      error,
      { chain_id: String(chainId) }
    );
    throw error;
  }

  if (!waitForConfirmation) {
    return { hash, confirmed: false };
  }

  const receipt = await waitForReceipt(rpcManager, hash);
  if (receipt.status === 0) {
    throw new Error(`Tempo transaction reverted (${hash})`);
  }
  return { hash, confirmed: true };
}

export type TempoReceiptStatus = "confirmed" | "reverted" | "pending";

/**
 * Single-shot receipt check (no waiting) for a broadcast tx hash. The scheduled
 * poller sends held payments without waiting, then a later tick reconciles them
 * to `confirmed`/`failed` via this. Returns `pending` when the tx is not mined
 * yet.
 */
export async function checkTempoReceipt(params: {
  chainId: number;
  userId?: string;
  txHash: string;
}): Promise<TempoReceiptStatus> {
  const { chainId, userId, txHash } = params;
  if (!isTempoChain(chainId)) {
    throw new Error(`Chain ${chainId} is not a Tempo network`);
  }
  const rpcManager = await getRpcProvider({ chainId, userId });
  const receipt = await rpcManager.executeWithFailover((provider) =>
    provider.getTransactionReceipt(txHash)
  );
  if (!receipt) {
    return "pending";
  }
  return receipt.status === 0 ? "reverted" : "confirmed";
}

/**
 * Build, sign, and broadcast one Tempo 0x76 transaction carrying `calls`,
 * waiting for a successful receipt. Composes `signTempoTx` and
 * `broadcastStoredTempoTx`; the four existing callers rely on this unchanged
 * signature.
 */
export async function signAndBroadcastTempoTx(
  params: SignAndBroadcastParams
): Promise<SignAndBroadcastResult> {
  const signed = await signTempoTx(params);
  const { hash } = await broadcastStoredTempoTx({
    chainId: params.chainId,
    userId: params.userId,
    serialized: signed.serialized,
    waitForConfirmation: true,
  });
  return { hash, from: signed.from };
}
