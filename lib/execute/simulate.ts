import "server-only";

import { ethers } from "ethers";
import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import { type AbiItem, findAbiFunction } from "@/lib/abi/utils";
import {
  describeNativeShortfall,
  getNativeSymbol,
  type INSUFFICIENT_BALANCE_CODE,
} from "@/lib/execute/native-balance";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { getRpcProvider } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
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

export type SimulateFailure = {
  success: false;
  status: "simulated";
  from: string;
  to: string;
  value: string;
  wouldRevert: true;
  revertReason: string;
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
  message: string
): SimulateFailure {
  return {
    success: false,
    status: "simulated",
    from,
    to,
    value: value.toString(),
    wouldRevert: true,
    revertReason: message,
    error: message,
  };
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
      ...failure(input.from, input.to, input.value, reason),
      originalError: getErrorMessage(input.err),
    };
  }

  const originalError = getErrorMessage(input.err);
  const revertData = extractRevertData(input.err);
  const shortfall = await nativeShortfallFailure({
    rpc: input.rpc,
    chainId: input.chainId,
    from: input.from,
    to: input.to,
    value: input.value,
    originalError,
    undecodedRevertData:
      revertData && revertData !== "0x" ? revertData : undefined,
  });
  return (
    shortfall ??
    failure(
      input.from,
      input.to,
      input.value,
      `Simulation reverted: ${originalError}`
    )
  );
}

async function getRpcManagerForChain(
  network: string
): Promise<{ rpc: RpcProviderManager; chainId: number }> {
  const chainId = getChainIdFromNetwork(network);
  const rpc = await getRpcProvider({ chainId });
  return { rpc, chainId };
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
  const from = await getOrganizationWalletAddress(input.organizationId);
  const to = input.contractAddress;

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

  const iface = new ethers.Interface(abiArray as ethers.InterfaceAbi);
  let encodedData: string;
  try {
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

  const { rpc, chainId } = await getRpcManagerForChain(input.network);
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
  const from = await getOrganizationWalletAddress(input.organizationId);
  const to = input.recipientAddress;

  const valueOrError = parseValue(input.amount);
  if (typeof valueOrError === "string") {
    return failure(from, to, BigInt(0), valueOrError);
  }
  const value = valueOrError;

  const { rpc, chainId } = await getRpcManagerForChain(input.network);
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
  const { rpc, chainId } = await getRpcManagerForChain(input.network);

  const resolvedTokenAddress = await parseTokenAddress(
    {
      tokenConfig: input.tokenConfig ?? "",
      tokenAddress: input.tokenAddress,
    },
    chainId
  );
  if (!resolvedTokenAddress) {
    const from = await getOrganizationWalletAddress(input.organizationId);
    return failure(
      from,
      input.tokenAddress ?? "",
      BigInt(0),
      "Simulating a token transfer requires a resolvable `tokenAddress` or `tokenConfig`"
    );
  }

  const decimals =
    input.decimals ?? (await fetchTokenDecimals(rpc, resolvedTokenAddress));

  let amountUnits: bigint;
  try {
    amountUnits = ethers.parseUnits(input.amount, decimals);
  } catch {
    const from = await getOrganizationWalletAddress(input.organizationId);
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
