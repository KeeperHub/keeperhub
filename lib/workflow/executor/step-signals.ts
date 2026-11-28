// Which steps only read, and what one step's output says about the run. Apart
// from run-outcome-keys, so only the run readers load the generated protocol list.
import { PROTOCOL_READ_ACTION_TYPES } from "./protocol-read-actions";
import {
  BUNDLE_STEP_ACTION_TYPES,
  bundleSignalsOfStep,
  fieldsOf,
  RUN_OUTCOME_OUTPUT,
  type RunOutcomeSignals,
  SENT_OUTPUT_KEYS,
} from "./run-outcome-keys";

/** The read-only steps outside the protocol actions, as the docs Billing paragraph lists them. */
export const CORE_READ_ONLY_STEP_TYPES: readonly string[] = [
  "trigger",
  "Condition",
  "State Get",
  "web3/read-contract",
  "Read Contract",
  "web3/check-balance",
  "Check Balance",
  "web3/check-token-balance",
  "web3/check-allowance",
  "web3/get-nonce",
  "web3/get-transaction",
  "web3/get-spl-token-balance",
  "web3/read-solana-account",
  "web3/read-solana-program-anchor",
];

/** Steps that only read: a waiting run made only of these (and the waiting bundle step) is not billed.
 * Any other step bills it, platform-service reads and fan-out (For Each, Batch Read Contract) included. */
export const READ_ONLY_STEP_TYPES: readonly string[] = [
  ...CORE_READ_ONLY_STEP_TYPES,
  ...PROTOCOL_READ_ACTION_TYPES,
];

/** Whether a step that ran (any status) did more than read: see READ_ONLY_STEP_TYPES. */
export function isOtherWorkStep(nodeType: string, output: unknown): boolean {
  const fields = fieldsOf(output);
  const sent = SENT_OUTPUT_KEYS.some((key) => {
    const value = fields?.[key];
    return value !== undefined && value !== null && value !== "";
  });
  if (sent) {
    return true;
  }
  if (BUNDLE_STEP_ACTION_TYPES.includes(nodeType)) {
    return (
      fields?.[RUN_OUTCOME_OUTPUT.routeKey] !== RUN_OUTCOME_OUTPUT.waitingRoute
    );
  }
  return !READ_ONLY_STEP_TYPES.includes(nodeType);
}

/** The signals one successful step's output carries: the bundle ones and whether it did more than read. */
export function signalsOfStep(
  nodeType: string,
  output: unknown
): RunOutcomeSignals {
  return {
    ...bundleSignalsOfStep(nodeType, output),
    otherWork: isOtherWorkStep(nodeType, output),
  };
}
