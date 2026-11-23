import "server-only";

import {
  ErrorCategory,
  logSystemError,
  logSystemWarn,
  logUserError,
} from "@/lib/logging";
import type { ProtocolInputGuardResult } from "@/lib/protocol-input-guards";
import { getProtocol, resolveContractAddress } from "@/lib/protocol-registry";
import { listOrgSafes } from "@/lib/safe/deployment";
import {
  resolveSignerForNode,
  SIGNER_MODE,
  type SignerMode,
} from "@/lib/safe/signer-resolver";
import { getErrorMessage } from "@/lib/utils";
import { readContractCore } from "@/plugins/web3/steps/read-contract-core";

/**
 * Guards that need a network round trip, kept apart from the cheap value
 * guards in protocol-input-guards.ts so the cheap ones can run before any I/O.
 *
 * Today there is one: Uniswap's `increaseLiquidity` is the only position
 * action with no ownership check. `decreaseLiquidity`, `collect` and `burn`
 * all carry `isAuthorizedForToken`, so a wrong token ID reverts on them. On
 * `increaseLiquidity` it succeeds: the tokens are deposited into whoever's
 * position the id names, the call reports a `liquidity` output, and the caller
 * has no claim on that NFT. The only thing that turns that silent loss into a
 * revert is reading the owner first.
 *
 * Because that deposit cannot be undone, every condition that leaves ownership
 * unestablished refuses the write rather than passing it. The read and the
 * write it guards resolve the same provider, so an outage that blinds the read
 * is an outage the write is behind too: refusing costs a clearer error message,
 * not a run that would otherwise have landed.
 */

// Both spellings the encoder accepts for a uint256. ethers takes either, and
// "0x2bfed" and "180205" produce byte-identical calldata, so a guard that
// recognised only decimal could be stepped around by rewriting the same id in
// hex - and the hex form reaches here from the direct-execute body untouched,
// or from a template that renders one.
const DECIMAL_TOKEN_ID = /^\d+$/;
// `0X` as well as `0x`: ethers accepts both, and a guard narrower than the
// encoder is the same mismatch in the other direction - it would refuse a
// write the encoder performs happily.
const HEX_TOKEN_ID = /^0[xX][0-9a-fA-F]+$/;

/**
 * The token id as the encoder will read it, in decimal, or undefined when it
 * is neither spelling. Normalising here means the `ownerOf` read asks about
 * the position the write will actually touch, whichever form the caller sent.
 */
function normalizeTokenId(raw: unknown): string | undefined {
  const value = String(raw ?? "").trim();
  if (!(DECIMAL_TOKEN_ID.test(value) || HEX_TOKEN_ID.test(value))) {
    return undefined;
  }
  try {
    return BigInt(value).toString();
  } catch {
    return undefined;
  }
}

type ProtocolOnchainGuardInput = {
  protocolSlug: string;
  functionName: string;
  /** Raw action inputs, keyed by input name. */
  inputs: Record<string, unknown>;
  network: string;
  organizationId: string | undefined;
  /**
   * The workflow execution this write belongs to, when there is one. RPC
   * preferences are resolved from the execution's user, so this is what lets
   * the ownerOf read use the same provider as the write it guards.
   */
  executionId?: string;
};

/**
 * The signer the write will use, resolved the way writeContractCore resolves
 * it. Returned whole rather than as one address because the guard needs both
 * the sender and the owner EOA behind it.
 *
 * Deliberately resolves under org policy with no `web3Connection`. Neither
 * write this guard covers honours that field - the direct-execute route records
 * a caller-supplied one as a rejected override rather than acting on it
 * (execution-service.ts), and protocolWriteStep leaves it out of the write's
 * input - so reading it here would let the guard compute a sender the write
 * never uses.
 */
async function resolveExecutingSigner(
  organizationId: string,
  chainId: number
): Promise<SignerMode> {
  return await resolveSignerForNode({
    organizationId,
    chainId,
    web3Connection: undefined,
    recordMetrics: false,
  });
}

/** The address that is msg.sender at the position manager for this mode. */
function senderOf(signerMode: SignerMode): string {
  // In safe and safe-role modes the Safe is msg.sender at the target, so it is
  // the Safe that transacts, not the owner EOA behind it.
  return signerMode.kind === SIGNER_MODE.EOA
    ? signerMode.ownerAddress
    : signerMode.safeAddress;
}

/**
 * Every address the organization itself controls on this chain: the owner EOA
 * behind the signer (returned in all three modes) and the org's Safes.
 *
 * This is deliberately not an approval check. `approve` and `setApprovalForAll`
 * are called by a position's owner naming whatever address they like, so a
 * stranger can approve this org's wallet on a position they keep. Reading the
 * approval would then answer "yes" for exactly the input the guard exists to
 * refuse - a tokenId the org does not control - while the owner keeps the
 * right to withdraw the deposit, revoke, or transfer the NFT away. Ownership
 * by an org address is the only answer that survives the owner acting against
 * us, and when it holds the deposit is recoverable with or without approvals.
 */
async function orgControlledAddresses(
  organizationId: string,
  chainId: number,
  signerMode: SignerMode
): Promise<Set<string>> {
  const addresses = new Set<string>([signerMode.ownerAddress.toLowerCase()]);
  for (const safe of await listOrgSafes(organizationId)) {
    if (safe.chainId === chainId) {
      addresses.add(safe.safeAddress.toLowerCase());
    }
  }
  return addresses;
}

/** Every refusal here is about the token id, so the field never varies. */
function refuse(error: string): ProtocolInputGuardResult {
  return { ok: false, field: "tokenId", error };
}

export async function checkProtocolOnchainGuards(
  input: ProtocolOnchainGuardInput
): Promise<ProtocolInputGuardResult> {
  const isUniswapIncrease =
    input.protocolSlug === "uniswap" &&
    input.functionName === "increaseLiquidity";
  if (!isUniswapIncrease) {
    return { ok: true };
  }

  const labels = { protocol: input.protocolSlug, function: input.functionName };

  // Not `typeof raw === "string"`: a JSON body carries `"tokenId": 180205` as a
  // number, and the direct-execute route passes the body through untouched, so
  // narrowing to strings would skip the read for exactly the caller this guard
  // exists to stop. A template rendering to a native value lands the same way.
  const tokenId = normalizeTokenId(input.inputs.tokenId);
  if (tokenId === undefined) {
    // Not the encoder's to reject after all: it takes decimal and hex alike
    // and has no numeric format check before it, so passing an unparseable id
    // through would leave the deposit unguarded on the strength of a premise
    // that does not hold.
    logUserError(
      ErrorCategory.VALIDATION,
      "[Protocol Guard] Ownership check refused: unusable token id",
      String(input.inputs.tokenId ?? ""),
      labels
    );
    return refuse(
      `"${String(input.inputs.tokenId ?? "")}" is not a position token ID. Give the ID as a decimal number (180205) or hex (0x2bfed).`
    );
  }

  const protocol = getProtocol(input.protocolSlug);
  const contract = protocol?.contracts.positionManager;
  const contractAddress = contract
    ? resolveContractAddress(contract, input.network, undefined)
    : undefined;
  // The registry's own ABI rather than a local copy of ownerOf: one
  // declaration, so a later correction to the shared file reaches the guard.
  const abi = contract?.abi;
  if (!(contractAddress && abi)) {
    logSystemWarn(
      ErrorCategory.CONFIGURATION,
      "[Protocol Guard] Ownership check refused: no position manager for this chain",
      input.network,
      labels
    );
    return refuse(
      `No Uniswap position manager is registered for chain ${input.network}, so this step cannot check who owns position ${tokenId}.`
    );
  }
  if (!input.organizationId) {
    // Unreachable from either route today - both pass an organization - but
    // WorkflowExecutionInput types it optional, so one caller that omits it
    // would otherwise turn this guard off for every increaseLiquidity in the
    // run. Refusing keeps the header's promise: nothing deposits into a
    // position whose holder was never established.
    logSystemWarn(
      ErrorCategory.CONFIGURATION,
      "[Protocol Guard] Ownership check refused: no organization context",
      undefined,
      labels
    );
    return refuse(
      `This step cannot check who owns position ${tokenId} without an organization context, and Uniswap performs no ownership check of its own on increaseLiquidity.`
    );
  }

  const chainId = Number(input.network);
  if (!Number.isFinite(chainId)) {
    // Without a chain id the org's Safes cannot be matched, so no check is
    // possible. The same value fails the write, so this only answers first.
    logUserError(
      ErrorCategory.VALIDATION,
      "[Protocol Guard] Ownership check refused: unusable network",
      input.network,
      labels
    );
    return refuse(
      `"${input.network}" is not a chain id this step can check position ownership on.`
    );
  }

  let signerMode: SignerMode;
  try {
    signerMode = await resolveExecutingSigner(input.organizationId, chainId);
  } catch (error) {
    // Not a pass. Failing to work out who signs is not evidence that the
    // position is owned, and swallowing it here would switch the guard off for
    // any input that makes signer resolution throw. The write resolves the
    // signer the same way, so it would fail too - this just says why first.
    logSystemWarn(
      ErrorCategory.CONFIGURATION,
      "[Protocol Guard] Could not resolve the signer for an ownership check",
      error,
      labels
    );
    return refuse(
      `Could not determine which wallet will send this transaction, so the position's ownership cannot be checked: ${getErrorMessage(error)}`
    );
  }

  const sender = senderOf(signerMode);
  if (!sender) {
    // A mode with no address cannot be compared against a holder.
    logSystemError(
      ErrorCategory.CONFIGURATION,
      "[Protocol Guard] Ownership check refused: signer has no address",
      { kind: signerMode.kind },
      labels
    );
    return refuse(
      `The wallet that would send this transaction has no address, so ownership of position ${tokenId} cannot be checked.`
    );
  }

  const read = await readContractCore({
    contractAddress,
    network: input.network,
    abi,
    abiFunction: "ownerOf",
    functionArgs: JSON.stringify([tokenId]),
    failOnError: false,
    // Match the provider the write will use. Pass executionId and never
    // organizationId: readContractCore treats organizationId as "skip the
    // preference lookup", so adding it would force the chain default even
    // where the write honours a user's RPC. The three callers:
    //
    // - Workflow runs: executionId is a workflowExecutions row, so
    //   getRpcPreferenceUserId finds the user and the read and the write both
    //   use their preferred RPC.
    // - /api/execute/node: executionId is a directExecutions row. That lookup
    //   selects from workflowExecutions only, misses, and returns undefined,
    //   so the read uses the chain default.
    // - /api/execute/{protocol}/{action}: the guard runs before reservation
    //   with no executionId, and that route's write passes organizationId, so
    //   both use the chain default.
    _context: { executionId: input.executionId },
  });

  if (!read.success || read.error !== undefined || read.result === null) {
    // A revert for an unminted or burned id and a transport failure arrive in
    // the same shape here: readContractCore funnels both through one catch and
    // failOnError=false softens both to a null result carrying a message, so
    // neither the shape nor errorClass separates them. Both refuse. A revert
    // would have failed the write too, and the read and the write share a
    // provider, so a transport failure is not a run this guard cost anyone.
    // logUserError rather than logSystemWarn: this needs a Prometheus counter
    // to alert on, and a mistyped id is not a Sentry error.
    logUserError(
      ErrorCategory.NETWORK_RPC,
      "[Protocol Guard] Ownership check refused: position owner unreadable",
      read.error ?? "no result",
      labels
    );
    // The read message can carry a provider URL, so it stays in the log.
    return refuse(
      `Could not read who owns position ${tokenId}. Uniswap performs no ownership check on increaseLiquidity, so this step will not deposit into a position it cannot verify. Check the token ID against Get Position Details, then retry.`
    );
  }

  // structureAbiOutputs wraps a single output in an object only when the ABI
  // names it, and the shared ABI declares ownerOf's output as "" - so what
  // comes back here is the bare address. Both shapes are read, rather than
  // the one the current ABI happens to produce: naming that output would
  // change the shipped uniswap/owner-of action's result from an address to an
  // object and break workflows templating off it, so the ABI must stay as it
  // is and this has to tolerate either.
  const result = read.result;
  const ownerValue =
    result !== null && typeof result === "object" && "owner" in result
      ? (result as { owner?: unknown }).owner
      : result;
  const owner = String(ownerValue ?? "").trim();
  if (owner === "") {
    // A decoded result with no address is as unverified as a failed read.
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Protocol Guard] Ownership check refused: ownerOf returned no address",
      read.result,
      labels
    );
    return refuse(
      `Could not read who owns position ${tokenId}: the position manager returned no address. This step will not deposit into a position it cannot verify.`
    );
  }
  if (owner.toLowerCase() === sender.toLowerCase()) {
    return { ok: true };
  }

  // The sender is not the holder. That is still fine when the holder is an
  // address the org controls - the EOA holds the position and the Safe signs,
  // or a second Safe of the org holds it - because the org can withdraw the
  // deposit in every one of those arrangements. Anything else, including a
  // position whose holder has approved this wallet, is refused: see
  // orgControlledAddresses for why an approval proves nothing here. Only
  // reached on a mismatch, so the common path still costs one read.
  let orgAddresses: Set<string>;
  try {
    orgAddresses = await orgControlledAddresses(
      input.organizationId,
      chainId,
      signerMode
    );
  } catch (error) {
    // The holder is already known not to be the sender, so an unreadable Safe
    // list leaves the one question that could still clear it unanswered.
    logSystemError(
      ErrorCategory.DATABASE,
      "[Protocol Guard] Ownership check refused: org wallets unreadable",
      error,
      labels
    );
    return refuse(
      `Position ${tokenId} belongs to ${owner}, and this organization's wallets could not be listed to confirm whether that is one of them.`
    );
  }
  if (orgAddresses.has(owner.toLowerCase())) {
    return { ok: true };
  }

  // The dominant refusal, and the only one that was not counted: a mistyped or
  // templated id naming a position the org does not hold. logUserError like the
  // unreadable-owner case above, so holder refusals show on the same counter
  // and a spike is visible rather than inferred from support tickets.
  logUserError(
    ErrorCategory.VALIDATION,
    "[Protocol Guard] Ownership check refused: position held outside the organization",
    undefined,
    labels
  );
  return refuse(
    `Position ${tokenId} belongs to ${owner}, which is not one of this organization's wallets (this step would send from ${sender}). Uniswap does not check ownership on increaseLiquidity, so adding liquidity to it would deposit your tokens into someone else's position with no way to withdraw them. If the position is yours, transfer the NFT to ${sender} or another of the organization's wallets and this step will accept it.`
  );
}
