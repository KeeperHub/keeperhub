import "server-only";

import { ethers, isError } from "ethers";
import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import { type AbiItem, findAbiFunction } from "@/lib/abi/utils";
import {
  describeNativeShortfall,
  getNativeSymbol,
  type INSUFFICIENT_BALANCE_CODE,
} from "@/lib/execute/native-balance";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider, isSolanaChain } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { isNonRetryableError } from "@/lib/rpc/providers/error-classification";
import { getErrorMessage } from "@/lib/utils";
import {
  decodeRevertReason,
  extractRevertData,
} from "@/lib/web3/decode-revert-error";
import { getOrganizationWalletAddress } from "@/lib/web3/wallet-helpers";
import { parseTokenAddress } from "@/plugins/web3/steps/transfer-token-core";

/**
 * Read-only execution-path simulator.
 *
 * Mirrors the input shape and chain-routing of the broadcast cores
 * (writeContractCore / transferFundsCore / transferTokenCore) but never
 * signs or sends a transaction. The result reports the gas the network
 * would charge, the decoded return value (if any), and whether the
 * call would revert with the decoded reason.
 *
 * Every chain call is routed through rpcManager.executeWithFailover so
 * a primary-RPC blip falls over to the chain's configured fallback,
 * matching the behaviour of read paths in the broadcast cores.
 *
 * When the preflight fails because the funding address cannot cover the
 * native value, the failure carries `code: "insufficient_balance"` with the
 * balance, the requirement and the shortfall — the same answer the broadcast
 * preflight gives — instead of the node's revert-data-less CALL_EXCEPTION.
 * Attribution only ever adds: the node's own message stays in
 * `originalError`, and revert data that failed to decode stays in
 * `undecodedRevertData`, so no failure is less informative than before.
 *
 * Known limitation: `from` is resolved via getOrganizationWalletAddress
 * (the org's EOA / smart account address). Orgs that route writes
 * through a Safe will produce a simulation that reflects the EOA
 * sending the call, not the Safe. This still catches most config bugs
 * (bad ABI, bad args, allowance mismatches) but does not perfectly mirror
 * Safe-routed msg.sender semantics.
 *
 * That limitation extends to the balance attribution: the shortfall is read
 * from `from`, while a Safe-routed org funds the transfer from
 * signerMode.safeAddress (see transfer-funds-core). So for those orgs
 * `code: "insufficient_balance"`, `balanceWei` and the "Fund <address>"
 * sentence describe the EOA and are not the address the broadcast spends
 * from. Do not treat them as authoritative without first resolving the
 * org's signer mode.
 */

const ERC20_TRANSFER_ABI_JSON = JSON.stringify([
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
]);

const ERC20_DECIMALS_ABI = [
  "function decimals() view returns (uint8)",
] as const;

const MAX_ERC20_DECIMALS = 255;

export type SimulateSuccess = {
  success: true;
  status: "simulated";
  from: string;
  to: string;
  value: string;
  gasEstimate: string;
  simulatedReturnValue: unknown;
  wouldRevert: false;
};

/**
 * Machine-readable causes the simulator can attribute a failure to.
 *
 * Named for the concept rather than its single current member: adding a
 * second code widens this union instead of replacing a one-literal alias,
 * so an exhaustive `switch` on the client keeps compiling.
 */
export type SimulateFailureCode = typeof INSUFFICIENT_BALANCE_CODE;

export type SimulationFailureKind = "validation" | "revert" | "unavailable";

type SimulateFailureBase = {
  success: false;
  status: "simulated";
  from: string;
  to: string;
  value: string;
  error: string;
  /**
   * Machine-readable cause, set only when the simulator could attribute the
   * failure to something more specific than "the call reverted". Clients
   * should branch on this rather than string-matching `revertReason`.
   */
  code?: SimulateFailureCode;
  /** Set with `code: "insufficient_balance"`: `from`'s native balance, in wei. */
  balanceWei?: string;
  /** Set with `code: "insufficient_balance"`: native value needed, in wei. */
  requiredWei?: string;
  /** Set with `code: "insufficient_balance"`: how much is missing, in wei. */
  shortfallWei?: string;
  /** Set with `code: "insufficient_balance"`: e.g. "ETH". */
  nativeSymbol?: string;
  /**
   * The node's own error message, kept verbatim whenever the simulator put
   * an attribution in `revertReason` instead. Attribution augments, never
   * discards: `revertReason` carries the actionable claim, this carries
   * what the chain actually said.
   */
  originalError?: string;
  /**
   * Revert data the node did return but which neither the supplied ABI, the
   * common-error list, nor `Error(string)` could decode. Look its first four
   * bytes up in a selector database to identify the custom error. Absent
   * when the node returned no revert data at all.
   */
  undecodedRevertData?: string;
};

export type SimulateFailure =
  | (SimulateFailureBase & {
      failureKind: "validation" | "revert";
      wouldRevert: true;
      revertReason: string;
    })
  | (SimulateFailureBase & {
      failureKind: "unavailable";
      wouldRevert: false;
      revertReason?: never;
    });

export type SimulateResult = SimulateSuccess | SimulateFailure;

export type SimulateContractCallInput = {
  organizationId: string;
  network: string;
  contractAddress: string;
  abi: string;
  functionName: string;
  functionArgs?: string;
  /** Decimal ETH (or native unit) value sent with the call. */
  value?: string;
};

export type SimulateNativeTransferInput = {
  organizationId: string;
  network: string;
  recipientAddress: string;
  /** Decimal ETH (or native unit). */
  amount: string;
};

export type SimulateTokenTransferInput = {
  organizationId: string;
  network: string;
  /**
   * Either a bare token address, or a `tokenConfig` payload (string or
   * object) accepted by the broadcast path. When both are missing the
   * call fails with a 400-style result.
   */
  tokenAddress?: string;
  tokenConfig?: string | Record<string, unknown>;
  recipientAddress: string;
  /** Decimal token-unit amount. */
  amount: string;
  /**
   * Optional explicit decimals override. If omitted the simulator
   * looks up the token's `decimals()` on-chain (with RPC failover) so
   * USDC / USDT etc. do not get parsed at the default 18.
   */
  decimals?: number;
};

type RpcManagerResolution =
  | { success: true; rpc: RpcProviderManager; chainId: number }
  | {
      success: false;
      failureKind: "validation" | "unavailable";
      error: string;
    };

function serializeForJson(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeForJson);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeForJson(v);
    }
    return out;
  }
  return value;
}

function failure(
  from: string,
  to: string,
  value: bigint,
  message: string,
  failureKind: "validation" | "revert" = "validation"
): SimulateFailure {
  return {
    success: false,
    status: "simulated",
    from,
    to,
    value: value.toString(),
    failureKind,
    wouldRevert: true,
    revertReason: message,
    error: message,
  };
}

function unavailable(
  from: string,
  to: string,
  value: bigint,
  message: string
): SimulateFailure {
  return {
    success: false,
    status: "simulated",
    from,
    to,
    value: value.toString(),
    failureKind: "unavailable",
    wouldRevert: false,
    error: message,
  };
}

function classifySimulationError(error: unknown): SimulationFailureKind {
  if (isError(error, "CALL_EXCEPTION")) {
    return "revert";
  }

  if (
    isError(error, "INVALID_ARGUMENT") ||
    isError(error, "MISSING_ARGUMENT") ||
    isError(error, "UNEXPECTED_ARGUMENT") ||
    isError(error, "NUMERIC_FAULT") ||
    isError(error, "INSUFFICIENT_FUNDS") ||
    isNonRetryableError(error)
  ) {
    return "validation";
  }

  return "unavailable";
}

/**
 * Attribute a failed preflight to a funding wallet that cannot cover the
 * transfer value.
 *
 * `eth_estimateGas` from an address holding less than `value` is rejected by
 * the node without revert data, which ethers surfaces as a bare
 * `missing revert data (action="estimateGas", ..., code=CALL_EXCEPTION)`.
 * That string names neither the balance nor the address, so a headless caller
 * — the exact case a dry run exists for — has nothing to act on. Read the
 * balance once, on the failure path only, and report the same shortfall the
 * broadcast preflight in transfer-funds-core already reports.
 *
 * Returns null whenever the balance does not explain the failure (or cannot
 * be read), so a real revert reason is never masked by a guess. The balance
 * is read for the same `from` the simulation used, inheriting the Safe
 * routing limitation documented at the top of this file.
 *
 * The comparison is `balance >= value` and deliberately ignores gas: the
 * estimate is what just failed, so there is no gas number to add. A wallet
 * holding exactly `value` therefore still fails on `value + gas * price`,
 * and this returns null for it — nodes answer that case with a readable
 * "insufficient funds for gas * price + value" of their own.
 */
async function nativeShortfallFailure(input: {
  rpc: RpcProviderManager;
  chainId: number;
  from: string;
  to: string;
  value: bigint;
  /** The node's own message, carried through so attribution discards nothing. */
  originalError: string;
  /** Revert data the node returned that nothing could decode, if any. */
  undecodedRevertData?: string;
}): Promise<SimulateFailure | null> {
  // A zero-value call can never be short, so skip the extra round trip.
  if (input.value <= BigInt(0)) {
    return null;
  }

  try {
    const balance = await input.rpc.executeWithFailover(
      (p) => p.getBalance(input.from),
      "preflight"
    );
    if (balance >= input.value) {
      return null;
    }
    const shortfall = describeNativeShortfall({
      symbol: await getNativeSymbol(input.chainId),
      balance,
      required: input.value,
      holder: input.from,
    });
    // The wallet is genuinely short, but a contract that also returned revert
    // data may be rejecting the call for an unrelated reason. Say both.
    const message = input.undecodedRevertData
      ? `${shortfall.message} The call also returned revert data no ABI here decodes (selector ${revertSelector(input.undecodedRevertData)}), so funding alone may not make it succeed.`
      : shortfall.message;
    return {
      ...failure(input.from, input.to, input.value, message),
      code: shortfall.code,
      balanceWei: shortfall.balanceWei,
      requiredWei: shortfall.requiredWei,
      shortfallWei: shortfall.shortfallWei,
      nativeSymbol: shortfall.nativeSymbol,
      originalError: input.originalError,
      undecodedRevertData: input.undecodedRevertData,
    };
  } catch {
    // Attribution is best-effort: it runs inside an error path, so it must
    // fall back to the original failure rather than raise one of its own.
    return null;
  }
}

function simulationFailureFromError(
  from: string,
  to: string,
  value: bigint,
  error: unknown,
  contractInterface?: ethers.Interface
): SimulateFailure {
  const decodedReason = decodeRevertReason(error, contractInterface);

  if (decodedReason) {
    return failure(from, to, value, decodedReason, "revert");
  }

  const failureKind = classifySimulationError(error);
  const message = getErrorMessage(error);

  if (failureKind === "unavailable") {
    return unavailable(from, to, value, `Simulation unavailable: ${message}`);
  }

  return failure(from, to, value, `Simulation failed: ${message}`, failureKind);
}

/** First four bytes of revert data: the selector an integrator can look up. */
function revertSelector(data: string): string {
  return ethers.dataLength(data) >= 4 ? ethers.dataSlice(data, 0, 4) : data;
}

/**
 * Turn a failed preflight into a SimulateFailure, shared by every path that
 * calls estimateGas.
 *
 * Order of preference: a decoded revert reason is the most specific answer,
 * so it wins outright. Otherwise the failure may be a funding shortfall —
 * attribute it, but never at the cost of what the node said. `decodeRevert-
 * Reason` returns undefined both when there was no revert data and when
 * there was revert data nothing could decode; the second case keeps its raw
 * bytes in `undecodedRevertData` and its selector in the message, and both
 * cases keep the node's message in `originalError`.
 */
async function failureFromPreflightError(input: {
  rpc: RpcProviderManager;
  chainId: number;
  from: string;
  to: string;
  value: bigint;
  err: unknown;
  /** The call's ABI, when there is one. Native sends have none. */
  iface?: ethers.Interface;
}): Promise<SimulateFailure> {
  const reason = decodeRevertReason(input.err, input.iface);
  if (reason) {
    // Keep the node's message here too. Native sends previously returned it
    // as the whole revertReason, so dropping it once decoding succeeded would
    // make this one branch less informative than before.
    return {
      ...failure(input.from, input.to, input.value, reason, "revert"),
      originalError: getErrorMessage(input.err),
    };
  }

  const originalError = getErrorMessage(input.err);
  const revertData = extractRevertData(input.err);
  const undecodedRevertData =
    revertData && revertData !== "0x" ? revertData : undefined;
  const shortfall = await nativeShortfallFailure({
    rpc: input.rpc,
    chainId: input.chainId,
    from: input.from,
    to: input.to,
    value: input.value,
    originalError,
    undecodedRevertData,
  });

  if (shortfall) {
    return shortfall;
  }

  const failureKind = classifySimulationError(input.err);
  if (failureKind === "unavailable") {
    return unavailable(
      input.from,
      input.to,
      input.value,
      `Simulation unavailable: ${originalError}`
    );
  }

  const message =
    failureKind === "revert"
      ? `Simulation reverted: ${originalError}`
      : `Simulation failed: ${originalError}`;

  return {
    ...failure(input.from, input.to, input.value, message, failureKind),
    originalError,
    undecodedRevertData,
  };
}

async function getRpcManagerForChain(
  network: string
): Promise<RpcManagerResolution> {
  let chainId: number;

  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return {
      success: false,
      failureKind: "validation",
      error: getErrorMessage(error),
    };
  }

  if (isSolanaChain(chainId)) {
    return {
      success: false,
      failureKind: "validation",
      error: "Read-only simulation currently supports EVM networks only",
    };
  }

  try {
    return {
      success: true,
      rpc: await getRpcProvider({ chainId }),
      chainId,
    };
  } catch {
    return {
      success: false,
      failureKind: "unavailable",
      error: "Simulation unavailable: RPC provider initialization failed",
    };
  }
}

function rpcResolutionFailure(
  resolution: Extract<RpcManagerResolution, { success: false }>,
  from: string,
  to: string,
  value: bigint
): SimulateFailure {
  return resolution.failureKind === "unavailable"
    ? unavailable(from, to, value, resolution.error)
    : failure(from, to, value, resolution.error);
}

async function resolveSimulationWallet(
  organizationId: string,
  to: string,
  value: bigint
): Promise<string | SimulateFailure> {
  try {
    return await getOrganizationWalletAddress(organizationId);
  } catch {
    return unavailable(
      "",
      to,
      value,
      "Simulation unavailable: could not resolve the organization wallet"
    );
  }
}

function validateDecimals(decimals: number): string | null {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_ERC20_DECIMALS
  ) {
    return `Invalid token decimals: ${decimals}`;
  }

  return null;
}

function parseFunctionArgs(raw: string | undefined): unknown[] | string {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return "functionArgs must be a JSON array";
    }
    return parsed;
  } catch {
    return "functionArgs is not valid JSON";
  }
}

function parseAbiArray(rawAbi: string): unknown[] | string {
  try {
    const parsed = JSON.parse(rawAbi) as unknown;
    if (!Array.isArray(parsed)) {
      return "ABI must be a JSON array";
    }
    return parsed;
  } catch {
    return "ABI is not valid JSON";
  }
}

function parseValue(raw: string | undefined): bigint | string {
  if (!raw) {
    return BigInt(0);
  }
  try {
    return ethers.parseEther(raw);
  } catch {
    return `Invalid value (expected decimal ether): ${raw}`;
  }
}

export async function simulateContractCall(
  input: SimulateContractCallInput
): Promise<SimulateResult> {
  const to = input.contractAddress;
  const fromOrFailure = await resolveSimulationWallet(
    input.organizationId,
    to,
    BigInt(0)
  );
  if (typeof fromOrFailure !== "string") {
    return fromOrFailure;
  }
  const from = fromOrFailure;

  const valueOrError = parseValue(input.value);
  if (typeof valueOrError === "string") {
    return failure(from, to, BigInt(0), valueOrError);
  }
  const value = valueOrError;

  const abiArrayOrError = parseAbiArray(input.abi);
  if (typeof abiArrayOrError === "string") {
    return failure(from, to, value, abiArrayOrError);
  }
  const abiArray = abiArrayOrError;

  const abiFn = findAbiFunction(abiArray as AbiItem[], input.functionName);
  if (!abiFn) {
    return failure(
      from,
      to,
      value,
      `Function ${input.functionName} not found in ABI`
    );
  }

  const argsOrError = parseFunctionArgs(input.functionArgs);
  if (typeof argsOrError === "string") {
    return failure(from, to, value, argsOrError);
  }

  let iface: ethers.Interface;
  let encodedData: string;
  try {
    iface = new ethers.Interface(abiArray as ethers.InterfaceAbi);
    const coerced = coerceArgsForAbi(argsOrError, abiFn);
    const reshaped = reshapeArgsForAbi(coerced, abiFn);
    encodedData = iface.encodeFunctionData(input.functionName, reshaped);
  } catch (err) {
    return failure(
      from,
      to,
      value,
      `Failed to encode call: ${getErrorMessage(err)}`
    );
  }

  const rpcResolution = await getRpcManagerForChain(input.network);
  if (!rpcResolution.success) {
    return rpcResolutionFailure(rpcResolution, from, to, value);
  }
  const { rpc, chainId } = rpcResolution;

  const tx: ethers.TransactionRequest = { from, to, data: encodedData, value };

  let gasEstimate: bigint;
  let returnData: string;
  try {
    // executeWithFailover routes the read through the chain's
    // fallback RPC when the primary blips, matching the read path
    // in the broadcast cores.
    [gasEstimate, returnData] = await rpc.executeWithFailover(
      (p) => Promise.all([p.estimateGas(tx), p.call(tx)]),
      "preflight"
    );
  } catch (err) {
    return await failureFromPreflightError({
      rpc,
      chainId,
      from,
      to,
      value,
      err,
      iface,
    });
  }

  let simulatedReturnValue: unknown = null;
  if (returnData && returnData !== "0x") {
    try {
      const decoded = iface.decodeFunctionResult(
        input.functionName,
        returnData
      );
      simulatedReturnValue =
        decoded.length === 1 ? decoded[0] : Array.from(decoded);
    } catch {
      simulatedReturnValue = returnData;
    }
  }

  return {
    success: true,
    status: "simulated",
    from,
    to,
    value: value.toString(),
    gasEstimate: gasEstimate.toString(),
    simulatedReturnValue: serializeForJson(simulatedReturnValue),
    wouldRevert: false,
  };
}

export async function simulateNativeTransfer(
  input: SimulateNativeTransferInput
): Promise<SimulateResult> {
  const to = input.recipientAddress;
  const fromOrFailure = await resolveSimulationWallet(
    input.organizationId,
    to,
    BigInt(0)
  );
  if (typeof fromOrFailure !== "string") {
    return fromOrFailure;
  }
  const from = fromOrFailure;

  const valueOrError = parseValue(input.amount);
  if (typeof valueOrError === "string") {
    return failure(from, to, BigInt(0), valueOrError);
  }
  const value = valueOrError;

  const rpcResolution = await getRpcManagerForChain(input.network);
  if (!rpcResolution.success) {
    return rpcResolutionFailure(rpcResolution, from, to, value);
  }
  const { rpc, chainId } = rpcResolution;

  const tx: ethers.TransactionRequest = { from, to, value };

  // Run estimateGas + provider.call together so a contract recipient
  // (fallback handler, precompile, etc.) surfaces its return bytes
  // alongside the gas estimate. For an EOA recipient the call returns
  // "0x" and simulatedReturnValue ends up null.
  let gasEstimate: bigint;
  let returnData: string;
  try {
    [gasEstimate, returnData] = await rpc.executeWithFailover(
      (p) => Promise.all([p.estimateGas(tx), p.call(tx)]),
      "preflight"
    );
  } catch (err) {
    // No ABI to pass: a native send has none. decodeRevertReason still
    // tries the common-error list and Error(string), so a reverting
    // contract recipient gets its reason decoded here too.
    return await failureFromPreflightError({
      rpc,
      chainId,
      from,
      to,
      value,
      err,
    });
  }

  return {
    success: true,
    status: "simulated",
    from,
    to,
    value: value.toString(),
    gasEstimate: gasEstimate.toString(),
    simulatedReturnValue: returnData && returnData !== "0x" ? returnData : null,
    wouldRevert: false,
  };
}

async function fetchTokenDecimals(
  rpc: RpcProviderManager,
  tokenAddress: string
): Promise<number> {
  const decimals = await rpc.executeWithFailover((p) => {
    const contract = new ethers.Contract(tokenAddress, ERC20_DECIMALS_ABI, p);
    return contract.decimals() as Promise<bigint>;
  }, "preflight");
  return Number(decimals);
}

export async function simulateTokenTransfer(
  input: SimulateTokenTransferInput
): Promise<SimulateResult> {
  const initialTokenAddress = input.tokenAddress ?? "";
  const fromOrFailure = await resolveSimulationWallet(
    input.organizationId,
    initialTokenAddress,
    BigInt(0)
  );
  if (typeof fromOrFailure !== "string") {
    return fromOrFailure;
  }
  const from = fromOrFailure;

  const rpcResolution = await getRpcManagerForChain(input.network);
  if (!rpcResolution.success) {
    return rpcResolutionFailure(
      rpcResolution,
      from,
      input.tokenAddress ?? "",
      BigInt(0)
    );
  }
  const { rpc, chainId } = rpcResolution;

  let resolvedTokenAddress: string | null;
  try {
    resolvedTokenAddress = await parseTokenAddress(
      {
        tokenConfig: input.tokenConfig ?? "",
        tokenAddress: input.tokenAddress,
      },
      chainId
    );
  } catch {
    return unavailable(
      from,
      input.tokenAddress ?? "",
      BigInt(0),
      "Simulation unavailable: could not resolve the token configuration"
    );
  }
  if (!resolvedTokenAddress) {
    return failure(
      from,
      input.tokenAddress ?? "",
      BigInt(0),
      "Simulating a token transfer requires a resolvable `tokenAddress` or `tokenConfig`"
    );
  }

  if (!ethers.isAddress(resolvedTokenAddress)) {
    return failure(
      from,
      resolvedTokenAddress,
      BigInt(0),
      `Invalid token address: ${resolvedTokenAddress}`
    );
  }

  let decimals: number;
  if (input.decimals === undefined) {
    try {
      decimals = await fetchTokenDecimals(rpc, resolvedTokenAddress);
    } catch (error) {
      return simulationFailureFromError(
        from,
        resolvedTokenAddress,
        BigInt(0),
        error
      );
    }
  } else {
    decimals = input.decimals;
  }

  const decimalsError = validateDecimals(decimals);
  if (decimalsError) {
    return failure(from, resolvedTokenAddress, BigInt(0), decimalsError);
  }

  let amountUnits: bigint;
  try {
    amountUnits = ethers.parseUnits(input.amount, decimals);
  } catch {
    return failure(
      from,
      resolvedTokenAddress,
      BigInt(0),
      `Invalid amount for ${decimals} decimals: ${input.amount}`
    );
  }

  return simulateContractCall({
    organizationId: input.organizationId,
    network: input.network,
    contractAddress: resolvedTokenAddress,
    abi: ERC20_TRANSFER_ABI_JSON,
    functionName: "transfer",
    functionArgs: JSON.stringify([
      input.recipientAddress,
      amountUnits.toString(),
    ]),
    value: undefined,
  });
}
