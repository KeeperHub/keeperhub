/**
 * Pure helpers for the Safe Allowance Module + Safe.execTransaction wrapping.
 *
 * No network calls, no DB access. All encoding logic lives here so the
 * orchestrator and unit tests share the same building blocks.
 *
 * Allowance Module ABI reference:
 *   https://github.com/safe-global/safe-modules/tree/main/modules/allowances
 */

import { ethers } from "ethers";
import { ZERO_ADDRESS } from "@/lib/safe/address";

/**
 * Safe v1.4.1 interface (only the functions we need to build calldata for
 * at the owner level). `enableModule` is how a Safe authorizes a module;
 * `execTransaction` is how an owner-signed call is dispatched.
 */
export const SAFE_EXEC_ABI = [
  "function enableModule(address module)",
  "function disableModule(address prevModule, address module)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool success)",
  "function nonce() view returns (uint256)",
] as const;

/**
 * Safe Allowance Module v0.1.0 ABI (only the pieces we call here).
 */
export const ALLOWANCE_MODULE_ABI = [
  "function addDelegate(address delegate)",
  "function removeDelegate(address delegate, bool removeAllowances)",
  "function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)",
  "function deleteAllowance(address delegate, address token)",
  "function executeAllowanceTransfer(address safe, address token, address payable to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)",
  "function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])",
  "function getTokens(address safe, address delegate) view returns (address[])",
] as const;

export const SAFE_OPERATION_CALL = 0 as const;

const safeInterface = new ethers.Interface(SAFE_EXEC_ABI);
const allowanceInterface = new ethers.Interface(ALLOWANCE_MODULE_ABI);

/**
 * Sentinel used by Safe to mark the start of the owners/modules linked
 * list. Passed as `prevModule` when removing the first-enabled module.
 */
export const SENTINEL_MODULES =
  "0x0000000000000000000000000000000000000001" as const;

export function buildEnableModuleCalldata(moduleAddress: string): string {
  return safeInterface.encodeFunctionData("enableModule", [moduleAddress]);
}

export function buildDisableModuleCalldata(options: {
  prevModule: string;
  module: string;
}): string {
  return safeInterface.encodeFunctionData("disableModule", [
    options.prevModule,
    options.module,
  ]);
}

export function buildAddDelegateCalldata(delegate: string): string {
  return allowanceInterface.encodeFunctionData("addDelegate", [delegate]);
}

export function buildRemoveDelegateCalldata(options: {
  delegate: string;
  removeAllowances: boolean;
}): string {
  return allowanceInterface.encodeFunctionData("removeDelegate", [
    options.delegate,
    options.removeAllowances,
  ]);
}

export type BuildSetAllowanceOptions = {
  delegate: string;
  token: string;
  allowanceAmount: bigint;
  resetTimeMinutes: number;
  resetBaseMinutes?: number;
};

export function buildSetAllowanceCalldata(
  options: BuildSetAllowanceOptions
): string {
  const {
    delegate,
    token,
    allowanceAmount,
    resetTimeMinutes,
    resetBaseMinutes,
  } = options;

  if (resetTimeMinutes < 0 || resetTimeMinutes > 0xff_ff) {
    throw new Error(
      `resetTimeMinutes must fit in uint16, got ${resetTimeMinutes}`
    );
  }
  if (
    allowanceAmount < BigInt(0) ||
    allowanceAmount > BigInt(2) ** BigInt(96) - BigInt(1)
  ) {
    throw new Error("allowanceAmount must fit in uint96");
  }

  return allowanceInterface.encodeFunctionData("setAllowance", [
    delegate,
    token,
    allowanceAmount,
    resetTimeMinutes,
    resetBaseMinutes ?? 0,
  ]);
}

export function buildDeleteAllowanceCalldata(options: {
  delegate: string;
  token: string;
}): string {
  return allowanceInterface.encodeFunctionData("deleteAllowance", [
    options.delegate,
    options.token,
  ]);
}

/**
 * Build the "pre-validated" signature bytes that Safe accepts when the
 * owner itself is the caller of execTransaction. Format (65 bytes):
 *   r = owner address padded to 32 bytes
 *   s = 32 bytes of zero
 *   v = 0x01
 *
 * This avoids ECDSA signing the inner safeTxHash; the outer tx IS already
 * signed by the EOA at the ethers layer, and Safe resolves `msg.sender`
 * against the encoded owner address.
 */
export function buildPreValidatedSignature(ownerAddress: string): string {
  const paddedOwner = ethers.zeroPadValue(ethers.getAddress(ownerAddress), 32);
  const zeroR = ethers.zeroPadValue("0x", 32);
  const v = "0x01";
  return ethers.concat([paddedOwner, zeroR, v]);
}

export type BuildExecTransactionOptions = {
  to: string;
  data: string;
  value?: bigint;
  operation?: number;
  ownerAddress: string;
};

/**
 * Encode Safe.execTransaction() calldata for an owner-signed single-owner
 * Safe (threshold 1). Gas fields are zero so the Safe reads them from the
 * outer tx (standard "no refund" path).
 *
 * The zero safeTxGas/gasPrice below is also what makes an inner-call failure
 * loud rather than silent. Safe ends execTransaction with
 * `require(success || safeTxGas != 0 || gasPrice != 0)`, so with both zero a
 * failing inner call reverts the entire outer transaction (receipt status 0).
 * Set either non-zero and the same failure instead returns status 1 with an
 * ExecutionFailure event, which every plain receipt.status check in this
 * codebase would read as success -- only the finalize-time verifier decodes
 * that event. Treat these zeros as load-bearing: making them configurable is a
 * deliberate decision about swallowing failures, not a parameterisation.
 */
export function buildExecTransactionCalldata(
  options: BuildExecTransactionOptions
): string {
  const {
    to,
    data,
    value = BigInt(0),
    operation = SAFE_OPERATION_CALL,
    ownerAddress,
  } = options;

  const signature = buildPreValidatedSignature(ownerAddress);

  return safeInterface.encodeFunctionData("execTransaction", [
    to,
    value,
    data,
    operation,
    0,
    0,
    0,
    ZERO_ADDRESS,
    ZERO_ADDRESS,
    signature,
  ]);
}

/**
 * Parse the uint256[5] returned by allowanceModule.getTokenAllowance into
 * something usable by the API layer. The module returns:
 *   [amount, spent, resetTimeMin, lastResetMin, nonce]
 */
export type TokenAllowanceState = {
  amount: bigint;
  spent: bigint;
  resetTimeMinutes: number;
  lastResetMinutes: number;
  nonce: bigint;
};

export function decodeTokenAllowance(
  raw: readonly [bigint, bigint, bigint, bigint, bigint]
): TokenAllowanceState {
  return {
    amount: raw[0],
    spent: raw[1],
    resetTimeMinutes: Number(raw[2]),
    lastResetMinutes: Number(raw[3]),
    nonce: raw[4],
  };
}
