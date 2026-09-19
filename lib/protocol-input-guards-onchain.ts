import "server-only";

import type { ProtocolInputGuardResult } from "@/lib/protocol-input-guards";
import { getProtocol, resolveContractAddress } from "@/lib/protocol-registry";
import { resolveSignerForNode, SIGNER_MODE } from "@/lib/safe/signer-resolver";
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

const OWNER_OF_ABI = JSON.stringify([
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
]);

const DIGITS = /^\d+$/;

export type ProtocolOnchainGuardInput = {
  protocolSlug: string;
  functionName: string;
  /** Raw action inputs, keyed by input name. */
  inputs: Record<string, unknown>;
  network: string;
  organizationId: string | undefined;
  web3Connection?: string | null;
};

/** The address that will be msg.sender, matching writeContractCore's resolution. */
async function resolveExecutingAddress(
  organizationId: string,
  network: string,
  web3Connection: string | null | undefined
): Promise<string | undefined> {
  const chainId = Number(network);
  if (!Number.isFinite(chainId)) {
    return undefined;
  }
  const signerMode = await resolveSignerForNode({
    organizationId,
    chainId,
    web3Connection,
    recordMetrics: false,
  });
  // In safe and safe-role modes the Safe is msg.sender at the target, so it is
  // the Safe that must hold the position, not the owner EOA.
  return signerMode.kind === SIGNER_MODE.EOA
    ? signerMode.ownerAddress
    : signerMode.safeAddress;
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
      input.network,
      input.web3Connection
    );
  } catch {
    expected = undefined;
  }
  if (!expected) {
    return { ok: true };
  }

  const read = await readContractCore({
    contractAddress,
    network: input.network,
    abi: OWNER_OF_ABI,
    abiFunction: "ownerOf",
    functionArgs: JSON.stringify([tokenId]),
    failOnError: false,
    // Without this the read resolves the system-default provider while the
    // rest of the route uses the org's. An org configures a custom RPC
    // precisely because the default is unreachable for it, so omitting this
    // fails the guard open exactly where the write it protects still lands.
    _context: { organizationId: input.organizationId },
  });

  if (!read.success || read.error !== undefined || read.result === null) {
    // ownerOf reverts for an id that was never minted or has been burned,
    // which is itself a wrong id - but an RPC outage lands here too and the
    // two are not distinguishable from this result shape. Refusing on an
    // outage would break every scheduled compound, so this passes and leaves
    // the position manager to accept a deposit the tip warns about.
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

  return {
    ok: false,
    field: "tokenId",
    error: `Position ${tokenId} belongs to ${owner}, not to this workflow's wallet (${expected}). Uniswap does not check ownership on increaseLiquidity, so adding liquidity to it would deposit your tokens into someone else's position with no way to withdraw them.`,
  };
}
