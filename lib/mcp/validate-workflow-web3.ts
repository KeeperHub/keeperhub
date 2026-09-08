// Pure Web3 fast-tier checks. NO DB calls (chainIds passed in by the
// route), NO RPC calls (network ID format check only; on-chain resolution
// is the deepCheck path in Plan 48-03). Token address check uses ethers
// isAddress for format validation only — no resolution.

import { ethers } from "ethers";
import {
  VALIDATION_ERROR_CODES,
  type ValidationErrorCode,
} from "@/lib/mcp/validate-workflow-codes";
import { isSolanaChain } from "@/lib/rpc/provider-factory";
import { validateChainAddress } from "@/lib/web3/validate-chain-address";

type Web3Issue = {
  code: ValidationErrorCode;
  message: string;
  parameterPath: string;
};

type NodeLike = {
  id?: unknown;
  data?: {
    type?: unknown;
    config?: Record<string, unknown>;
  } | null;
};

/**
 * VALID-05: per-node chain ID existence.
 *
 * Walks every node config; for any string-typed `network` field, parses
 * it as an integer and asserts membership in the provided chainIds Set.
 * The Set is pre-fetched by the API route (NOT here — keeps this module
 * pure).
 *
 * Per-node scope mitigates PITFALLS pitfall #12 (multi-chain WETH): each
 * node's network is validated independently, never against a workflow
 * top-level chain column.
 */
export function chainExists(
  nodes: unknown,
  chainIds: Set<number>
): Web3Issue[] {
  const issues: Web3Issue[] = [];
  if (!Array.isArray(nodes)) {
    return issues;
  }
  for (const [idx, rawNode] of nodes.entries()) {
    const network = readStringConfig(rawNode as NodeLike, "network");
    if (network === null) {
      continue;
    }
    // A network supplied by the caller arrives as a template reference and is
    // resolved at execution time, so there is no chain id to check statically.
    // Two limits on the skip, both cases where a template is wrong rather than
    // unresolvable: a trigger's own network is never resolved by anything, and
    // the reference has to be the whole value.
    //
    // A trigger is identified the same way this module's caller identifies one
    // — by data.type — and not by the presence of triggerType, which
    // sanitize-nodes only injects for Schedule nodes. A trigger imported
    // without it would otherwise be read as an action, take the skip, and
    // validate clean while the event listener drops the workflow for a
    // non-numeric chain id and it never fires.
    const isTriggerNode =
      (rawNode as NodeLike)?.data?.type === "trigger" ||
      readStringConfig(rawNode as NodeLike, "triggerType") !== null;
    if (!isTriggerNode && isWholeTemplateReference(network)) {
      continue;
    }
    const parsed = Number(network);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      issues.push({
        code: VALIDATION_ERROR_CODES.UNKNOWN_CHAIN_ID,
        message: `nodes[${idx}].config.network "${network}" is not a numeric chain ID string`,
        parameterPath: `nodes[${idx}].config.network`,
      });
      continue;
    }
    if (!chainIds.has(parsed)) {
      issues.push({
        code: VALIDATION_ERROR_CODES.UNKNOWN_CHAIN_ID,
        message: `Chain ID ${parsed} is not enabled in the chains table`,
        parameterPath: `nodes[${idx}].config.network`,
      });
    }
  }
  return issues;
}

/**
 * Resolves a node's `network` config to a chain ID for format-checking
 * purposes, or null when it can't be determined statically (missing, or a
 * template reference resolved at execution time - same skip condition
 * chainExists above uses). A null result means the address format check
 * below falls back to accepting either EVM or Solana shape, since the
 * chain family that will actually validate it is unknown here.
 */
function resolveNodeChainId(rawNode: NodeLike): number | null {
  const network = readStringConfig(rawNode, "network");
  if (network === null || isWholeTemplateReference(network)) {
    return null;
  }
  const parsed = Number(network);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// validateChainAddress only branches on isSolanaChain(chainId), never on the
// specific chain ID within a family, so any Solana chain ID stands in for
// "check base58 shape" when a node's actual chain is unknown (see the null
// branch of isValidAddressForNode below).
const ANY_SOLANA_CHAIN_ID = 101;

/**
 * Format-checks an address against the chain family resolved for this node.
 * When the chain can't be determined statically, accepts either EVM or
 * Solana shape rather than defaulting to EVM-only and false-positiving on
 * every Solana workflow this validator has no chain context for.
 */
function isValidAddressForNode(
  address: string,
  chainId: number | null
): boolean {
  if (chainId !== null) {
    return validateChainAddress(address, chainId);
  }
  return (
    ethers.isAddress(address) ||
    validateChainAddress(address, ANY_SOLANA_CHAIN_ID)
  );
}

/**
 * VALID-06: per-node token / contract address format.
 *
 * Walks every node config; for any string-typed `contractAddress` (and
 * any address inside `tokenConfig` JSON), validates against the node's
 * resolved chain family (EVM 0x-hex or Solana base58 - see
 * lib/web3/validate-chain-address.ts). Empty strings and missing fields are
 * SKIPPED (those are a different validation surface — required-field checks
 * belong to the editor).
 */
export function tokenAddressFormat(nodes: unknown): Web3Issue[] {
  const issues: Web3Issue[] = [];
  if (!Array.isArray(nodes)) {
    return issues;
  }
  for (const [idx, rawNode] of nodes.entries()) {
    const chainId = resolveNodeChainId(rawNode as NodeLike);
    const formatLabel =
      chainId !== null && isSolanaChain(chainId) ? "Solana" : "EVM";

    const contractAddress = readStringConfig(
      rawNode as NodeLike,
      "contractAddress"
    );
    if (
      contractAddress !== null &&
      contractAddress.length > 0 &&
      !isTemplateReference(contractAddress) &&
      !isValidAddressForNode(contractAddress, chainId)
    ) {
      issues.push({
        code: VALIDATION_ERROR_CODES.INVALID_TOKEN_ADDRESS,
        message: `nodes[${idx}].config.contractAddress "${contractAddress}" is not a valid ${formatLabel} address`,
        parameterPath: `nodes[${idx}].config.contractAddress`,
      });
    }

    // tokenConfig is a JSON string (token-select field type — see
    // app/api/mcp/schemas/route.ts). Parse best-effort; malformed JSON
    // is silently skipped (not a false-positive class).
    const tokenConfigStr = readStringConfig(rawNode as NodeLike, "tokenConfig");
    if (tokenConfigStr === null || tokenConfigStr.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(tokenConfigStr);
    } catch {
      continue;
    }
    const embeddedAddress = extractTokenConfigAddress(parsed);
    if (
      embeddedAddress !== null &&
      !isTemplateReference(embeddedAddress) &&
      !isValidAddressForNode(embeddedAddress, chainId)
    ) {
      issues.push({
        code: VALIDATION_ERROR_CODES.INVALID_TOKEN_ADDRESS,
        message: `nodes[${idx}].config.tokenConfig.customToken.address "${embeddedAddress}" is not a valid ${formatLabel} address`,
        parameterPath: `nodes[${idx}].config.tokenConfig.customToken.address`,
      });
    }
  }
  return issues;
}

// Address fields may hold a `{{...}}` template that resolves to a real
// address at execution time (e.g. `{{@prep:Prep.governor_address_safe}}`).
// These are not literal addresses, so the ethers.isAddress format check
// must skip them rather than report a false invalid-token-address.
const TEMPLATE_REFERENCE_RE = /\{\{.*?\}\}/;

export function isTemplateReference(value: string): boolean {
  return TEMPLATE_REFERENCE_RE.test(value);
}

/**
 * True when the value is a single template reference and nothing else.
 *
 * Stricter than isTemplateReference, which matches a `{{...}}` anywhere in the
 * value. That is right for an address, whose resolved value is re-checked with
 * ethers.isAddress before use, and wrong for a chain id, which is substituted
 * whole and never re-validated: "1{{@a:B.c}}" would skip the check and then
 * resolve into a chain the author never chose.
 *
 * An empty or whitespace-only body is not a reference any resolver in the repo
 * recognises. A closing brace inside the body is not either: TEMPLATE_PATTERN
 * in lib/utils/template.ts is /\{\{([^}]+)\}\}/g, so the body it accepts may
 * contain "{" but never "}". Rejecting "{" here would flag "{{a{b}}", which
 * resolves at execution time — exactly the false positive this skip exists to
 * remove.
 */
export function isWholeTemplateReference(value: string): boolean {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{{") && trimmed.endsWith("}}"))) {
    return false;
  }
  const body = trimmed.slice(2, -2);
  return body.trim().length > 0 && !body.includes("}");
}

function readStringConfig(node: NodeLike, key: string): string | null {
  const config = node?.data?.config;
  if (config === undefined || config === null) {
    return null;
  }
  const value = config[key];
  return typeof value === "string" ? value : null;
}

function extractTokenConfigAddress(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as { customToken?: unknown };
  if (
    obj.customToken === null ||
    obj.customToken === undefined ||
    typeof obj.customToken !== "object"
  ) {
    return null;
  }
  const customToken = obj.customToken as { address?: unknown };
  return typeof customToken.address === "string" ? customToken.address : null;
}
