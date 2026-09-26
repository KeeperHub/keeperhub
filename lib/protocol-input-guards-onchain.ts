import "server-only";

import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import type { ProtocolInputGuardResult } from "@/lib/protocol-input-guards";
import { getProtocol, resolveContractAddress } from "@/lib/protocol-registry";
import { resolveSignerForNode, SIGNER_MODE } from "@/lib/safe/signer-resolver";
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
 */

const POSITION_AUTH_ABI = JSON.stringify([
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
  {
    type: "function",
    name: "getApproved",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "operator", type: "address" }],
  },
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "approved", type: "bool" }],
  },
]);

const DIGITS = /^\d+$/;

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
 * The address that will be msg.sender, matching writeContractCore's resolution.
 *
 * Deliberately resolves under org policy with no `web3Connection`. Neither
 * write this guard covers honours that field - the direct-execute route records
 * a caller-supplied one as a rejected override rather than acting on it
 * (execution-service.ts), and protocolWriteStep leaves it out of the write's
 * input - so reading it here would let the guard compute a sender the write
 * never uses.
 */
async function resolveExecutingAddress(
  organizationId: string,
  network: string
): Promise<string | undefined> {
  const chainId = Number(network);
  if (!Number.isFinite(chainId)) {
    return undefined;
  }
  const signerMode = await resolveSignerForNode({
    organizationId,
    chainId,
    web3Connection: undefined,
    recordMetrics: false,
  });
  // In safe and safe-role modes the Safe is msg.sender at the target, so it is
  // the Safe that must hold the position, not the owner EOA.
  return signerMode.kind === SIGNER_MODE.EOA
    ? signerMode.ownerAddress
    : signerMode.safeAddress;
}

/**
 * Whether `expected` may act on the position without owning it, the way the
 * position manager's own `_isApprovedOrOwner` decides it: the single-token
 * approval, or blanket operator approval from the owner.
 *
 * Returns undefined when neither could be read. That is not the same as "no":
 * the caller refuses either way here, since the owner is already known not to
 * match, but the message says which of the two it is.
 */
async function isApprovedOperator(args: {
  contractAddress: string;
  executionId: string | undefined;
  expected: string;
  network: string;
  owner: string;
  tokenId: string;
}): Promise<boolean | undefined> {
  const call = async (abiFunction: string, functionArgs: unknown[]) =>
    await readContractCore({
      contractAddress: args.contractAddress,
      network: args.network,
      abi: POSITION_AUTH_ABI,
      abiFunction,
      functionArgs: JSON.stringify(functionArgs),
      failOnError: false,
      _context: { executionId: args.executionId },
    });

  const wanted = args.expected.toLowerCase();
  // Both views have to answer before "not approved" is a fact. If either is
  // unreadable the answer is unknown, not no.
  let unreadable = false;

  const approved = await call("getApproved", [args.tokenId]);
  if (approved.success && approved.error === undefined) {
    const operator = String(
      (approved.result as { operator?: unknown } | null)?.operator ?? ""
    )
      .trim()
      .toLowerCase();
    if (operator !== "" && operator === wanted) {
      return true;
    }
  } else {
    unreadable = true;
  }

  const forAll = await call("isApprovedForAll", [args.owner, args.expected]);
  if (forAll.success && forAll.error === undefined) {
    if ((forAll.result as { approved?: unknown } | null)?.approved === true) {
      return true;
    }
  } else {
    unreadable = true;
  }

  return unreadable ? undefined : false;
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

  // Not `typeof raw === "string"`: a JSON body carries `"tokenId": 180205` as a
  // number, and the direct-execute route passes the body through untouched, so
  // narrowing to strings would skip the read for exactly the caller this guard
  // exists to stop. A template rendering to a native value lands the same way.
  const tokenId = String(input.inputs.tokenId ?? "").trim();
  // A malformed id is the encoder's to reject, with its own message.
  if (!DIGITS.test(tokenId)) {
    return { ok: true };
  }

  const protocol = getProtocol(input.protocolSlug);
  const contract = protocol?.contracts.positionManager;
  const contractAddress = contract
    ? resolveContractAddress(contract, input.network, undefined)
    : undefined;
  if (!(contractAddress && input.organizationId)) {
    // No registry address or no org context (direct tooling): nothing to
    // compare against. The cheap guards and the encoder still apply.
    return { ok: true };
  }

  let expected: string | undefined;
  try {
    expected = await resolveExecutingAddress(
      input.organizationId,
      input.network
    );
  } catch (error) {
    // Not a pass. Failing to work out who signs is not evidence that the
    // position is owned, and swallowing it here would switch the guard off for
    // any input that makes signer resolution throw. The write resolves the
    // signer the same way, so it would fail too - this just says why first.
    logSystemWarn(
      ErrorCategory.CONFIGURATION,
      "[Protocol Guard] Could not resolve the signer for an ownership check",
      error,
      { protocol: input.protocolSlug, function: input.functionName }
    );
    return {
      ok: false,
      field: "tokenId",
      error: `Could not determine which wallet will send this transaction, so the position's ownership cannot be checked: ${getErrorMessage(error)}`,
    };
  }
  if (!expected) {
    return { ok: true };
  }

  const read = await readContractCore({
    contractAddress,
    network: input.network,
    abi: POSITION_AUTH_ABI,
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
    // ownerOf reverts for an id that was never minted or has been burned,
    // which is itself a wrong id - but an RPC outage lands here too and the
    // two are not distinguishable from this result shape. Refusing on an
    // outage would break every scheduled compound, so this passes and leaves
    // the position manager to accept a deposit the tip warns about. Logged so
    // the skips are countable: this is the guard being off, silently, on the
    // one call that cannot be undone.
    logSystemWarn(
      ErrorCategory.NETWORK_RPC,
      "[Protocol Guard] Ownership check skipped: position owner unreadable",
      read.error ?? "no result",
      { protocol: input.protocolSlug, function: input.functionName }
    );
    return { ok: true };
  }

  // readContractCore runs results through structureAbiOutputs, which wraps a
  // single *named* output as { owner: value } - so the value is behind the
  // ABI's output name, not the result itself.
  const owner = String(
    (read.result as { owner?: unknown } | null)?.owner ?? ""
  ).trim();
  if (owner === "") {
    return { ok: true };
  }
  if (owner.toLowerCase() === expected.toLowerCase()) {
    return { ok: true };
  }

  // Owning the NFT is not the only arrangement that can get the liquidity back
  // out. The position manager gates decreaseLiquidity, collect and burn on
  // _isApprovedOrOwner, so an approved operator can withdraw everything this
  // step adds. A position held by the org EOA with the Safe approved is
  // legitimate and fully recoverable; refusing it on owner equality alone
  // would block it permanently. Only reached on a mismatch, so the common
  // path still costs one read.
  const authorized = await isApprovedOperator({
    contractAddress,
    executionId: input.executionId,
    expected,
    network: input.network,
    owner,
    tokenId,
  });
  if (authorized === true) {
    return { ok: true };
  }

  const qualifier =
    authorized === undefined
      ? " Its approvals could not be read, so this is refused rather than assumed."
      : "";
  return {
    ok: false,
    field: "tokenId",
    error: `Position ${tokenId} belongs to ${owner}, not to this workflow's wallet (${expected}), which is not an approved operator for it either.${qualifier} Uniswap does not check ownership on increaseLiquidity, so adding liquidity to it would deposit your tokens into someone else's position with no way to withdraw them.`,
  };
}
