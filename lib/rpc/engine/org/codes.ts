/**
 * Codes the organization RPC routes answer with. Plain constants with no
 * server imports, so the settings UI can branch on the same values.
 */

/** Why a request to change an organization's RPC setup was refused. */
export const OrgRpcErrorCode = {
  INVALID_INPUT: "INVALID_INPUT",
  CHAIN_UNAVAILABLE: "CHAIN_UNAVAILABLE",
  NOT_FOUND: "NOT_FOUND",
  NAME_TAKEN: "NAME_TAKEN",
  VERIFICATION_FAILED: "VERIFICATION_FAILED",
  COVERAGE_GAPS: "COVERAGE_GAPS",
} as const;
export type OrgRpcErrorCode =
  (typeof OrgRpcErrorCode)[keyof typeof OrgRpcErrorCode];

/** Why a single URL did not pass its check against the chain. */
export const RpcUrlCheckFailure = {
  INVALID_URL: "INVALID_URL",
  WRONG_SCHEME: "WRONG_SCHEME",
  SLOT_NOT_SUPPORTED: "SLOT_NOT_SUPPORTED",
  NOT_PUBLIC: "NOT_PUBLIC",
  UNREACHABLE: "UNREACHABLE",
  WRONG_CHAIN: "WRONG_CHAIN",
} as const;
export type RpcUrlCheckFailure =
  (typeof RpcUrlCheckFailure)[keyof typeof RpcUrlCheckFailure];
