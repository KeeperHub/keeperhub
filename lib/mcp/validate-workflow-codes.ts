// Stable kebab-case codes for validate_workflow. Adding a code is
// additive — agents tolerate unknown codes (treat as a generic warning
// or error per the response shape). Renaming a code is a breaking
// change for any downstream parser; do not rename existing codes.

export const VALIDATION_ERROR_CODES = {
  EMPTY_NODES_ARRAY: "empty-nodes-array",
  UNKNOWN_EDGE_REFERENCE: "unknown-edge-reference",
  MISSING_TRIGGER_CONFIG: "missing-trigger-config",
  BARE_AT_LITERAL_IN_TEMPLATE: "bare-at-literal-in-template",
  MISSING_INPUT_SCHEMA_ON_LISTED: "missing-input-schema-on-listed",
  UNKNOWN_OUTPUT_MAPPING_NODE: "unknown-output-mapping-node",
  MISSING_WRITE_ACTION_FOR_WRITE_WORKFLOW:
    "missing-write-action-for-write-workflow",
  // Web3 codes added in Plan 48-02:
  UNKNOWN_CHAIN_ID: "unknown-chain-id",
  INVALID_TOKEN_ADDRESS: "invalid-token-address",
  // web3/disburse records each leg from the pre-broadcast hook, which the Safe
  // and Role signer paths never run.
  DISBURSE_SIGNER_UNSUPPORTED: "disburse-signer-unsupported",
} as const;

export const VALIDATION_WARNING_CODES = {
  WRITE_ACTION_ON_READ_WORKFLOW: "write-action-on-read-workflow",
  // Not a behavioural guardrail: the executor cannot yet deduplicate a loop
  // body across a re-run (it needs the full nesting path first,
  // step-claim.ts:14-20), so this only names the risk. The fix that
  // actually resumes without re-paying is switching the node to
  // web3/disburse.
  TRANSFER_IN_FOR_EACH_BODY: "transfer-in-for-each-body",
  // ABI deep-check code added in Plan 48-03:
  LOW_CONFIDENCE_ABI_MATCH: "low-confidence-abi-match",
  // Configure-time hint: write-contract uses an allowance-consuming method
  // (transferFrom / redeem / withdrawFrom) with no check-allowance node.
  MISSING_ALLOWANCE_PREFLIGHT: "missing-allowance-preflight",
} as const;

export type ValidationErrorCode =
  (typeof VALIDATION_ERROR_CODES)[keyof typeof VALIDATION_ERROR_CODES];
export type ValidationWarningCode =
  (typeof VALIDATION_WARNING_CODES)[keyof typeof VALIDATION_WARNING_CODES];
