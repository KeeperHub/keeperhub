// Pure Web3 fast-tier checks. NO DB calls (chainIds passed in by the
// route), NO RPC calls (network ID format check only; on-chain resolution
// is the deepCheck path in Plan 48-03). Token address check uses ethers
// isAddress for format validation only — no resolution.

import { ethers } from "ethers";
import {
  VALIDATION_ERROR_CODES,
  type ValidationErrorCode,
} from "@/lib/mcp/validate-workflow-codes";

type Web3Issue = {
  code: ValidationErrorCode;
  message: string;
  parameterPath: string;
};

type NodeLike = {
  id?: unknown;
  data?: {
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
 * VALID-06: per-node token / contract address format.
 *
 * Walks every node config; for any string-typed `contractAddress` (and
 * any address inside `tokenConfig` JSON), validates with ethers.isAddress.
 * Empty strings and missing fields are SKIPPED (those are a different
 * validation surface — required-field checks belong to the editor).
 */
export function tokenAddressFormat(nodes: unknown): Web3Issue[] {
  const issues: Web3Issue[] = [];
  if (!Array.isArray(nodes)) {
    return issues;
  }
  for (const [idx, rawNode] of nodes.entries()) {
    const contractAddress = readStringConfig(
      rawNode as NodeLike,
      "contractAddress"
    );
    if (
      contractAddress !== null &&
      contractAddress.length > 0 &&
      !isTemplateReference(contractAddress) &&
      !ethers.isAddress(contractAddress)
    ) {
      issues.push({
        code: VALIDATION_ERROR_CODES.INVALID_TOKEN_ADDRESS,
        message: `nodes[${idx}].config.contractAddress "${contractAddress}" is not a valid EVM address`,
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
      !ethers.isAddress(embeddedAddress)
    ) {
      issues.push({
        code: VALIDATION_ERROR_CODES.INVALID_TOKEN_ADDRESS,
        message: `nodes[${idx}].config.tokenConfig.customToken.address "${embeddedAddress}" is not a valid EVM address`,
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
