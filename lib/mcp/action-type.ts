/**
 * Shared "is this actionType a write action" check. Used by both the MCP
 * calldata generator (calldata.ts) and the deep validator
 * (validate-workflow-deep.ts) so the two classifications cannot drift.
 *
 * web3/batch-write-contract matches too: calldata.ts encodes it as a single
 * aggregate3(Call3[]) call against Multicall3, so it is exactly as
 * calldata-generatable as a single write-contract call, just via a different
 * encoder. See generateCalldataForWorkflow's batch branch.
 */
export const BATCH_WRITE_CONTRACT_ACTION_TYPE = "web3/batch-write-contract";

export function isWriteActionType(actionType: unknown): boolean {
  if (typeof actionType !== "string") {
    return false;
  }
  return (
    actionType.includes("write-contract") ||
    actionType.includes("protocol-write")
  );
}

// Mutating action types that isWriteActionType deliberately excludes because
// they cannot be served by the MCP calldata-handoff route: their config
// carries no raw ABI/function/args at all (e.g. approve-token's config is
// tokenConfig/spenderAddress/amount), so encoding one requires action-specific
// semantic knowledge the calldata generator does not have. They do genuinely
// broadcast a signed transaction from the org wallet, though. Kept separate
// from isWriteActionType, which callers rely on staying in lockstep with the
// calldata generator; widening it here would let a workflow using one of
// these actions validate as workflowType="write" and then fail every real
// MCP call with "No write action node found in workflow".
const NON_CALLDATA_MUTATING_ACTION_TYPES = new Set([
  "web3/approve-token",
  "web3/transfer-funds",
  "web3/transfer-token",
  // Tempo is a stablecoin chain with no native gas token, so none of its
  // writes carry native value and the daily value cap never sees them. Every
  // one broadcasts a signed TIP-20 transaction from the org wallet, and none
  // matches write-contract/protocol-write, so without these entries a
  // Tempo-only workflow reads as non-mutating.
  "tempo/transfer-with-memo",
  "tempo/batch-payout",
  "tempo/dex-swap",
  "tempo/hold-payment",
]);

// Actions with no on-chain effect that are still not read-only: each one
// leaves a message a caller cannot recall. lib/mcp/tools.ts already applies
// exactly this rule to test_notification, annotating it destructive because it
// "sends to a caller-named target and cannot recall the message"; a listing
// whose nodes do the same send has to be treated the same way or the two
// surfaces disagree about identical behaviour.
const OUTBOUND_MESSAGE_ACTION_TYPES = new Set([
  "discord/send-message",
  "slack/send-message",
  "telegram/send-message",
  "sendgrid/send-email",
  "resend/send-email",
]);

/**
 * Broader than isWriteActionType: true for any action type that mutates
 * chain state, whether or not it can be served by the calldata-handoff
 * route. Never use this to gate the calldata-generation/workflowType="write"
 * path, which must stay scoped to isWriteActionType.
 */
export function isMutatingActionType(actionType: unknown): boolean {
  if (typeof actionType !== "string") {
    return false;
  }
  return (
    NON_CALLDATA_MUTATING_ACTION_TYPES.has(actionType) ||
    isWriteActionType(actionType)
  );
}

/**
 * True for any action type with an effect the caller cannot take back: a
 * broadcast transaction or an outbound message.
 *
 * This is the predicate for MCP annotations, not isMutatingActionType. Under
 * the MCP spec readOnlyHint means the tool does not modify its environment,
 * which is wider than "does not modify chain state" -- sending an email
 * modifies the world just as permanently as a transfer does, and an agent
 * auto-approving one on a read-only hint is the same failure.
 *
 * Both sets are allowlists of known effects, so an action type absent from
 * them still reads as side-effect-free. Deriving this from a declared
 * side-effect field on PluginAction would close that gap for good; until then
 * a new broadcasting plugin has to be added here, and the test suite pins the
 * current membership so the omission surfaces as a failing case rather than a
 * silent auto-approval.
 */
export function hasIrreversibleEffect(actionType: unknown): boolean {
  if (typeof actionType !== "string") {
    return false;
  }
  return (
    isMutatingActionType(actionType) ||
    OUTBOUND_MESSAGE_ACTION_TYPES.has(actionType)
  );
}
