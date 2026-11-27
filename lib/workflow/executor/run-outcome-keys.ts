// No imports: the step code that sets these keys loads without the SQL readers.

/** The output keys a step sets the run outcome with, shared by the TS and SQL readers. */
export const RUN_OUTCOME_OUTPUT = {
  routeKey: "route",
  skippedInFlightRoute: "skipped-in-flight",
  notIncludedReasonKey: "notIncludedReason",
} as const;

/** Only Write Contract (and its legacy name) sends bundles, so only it may set the outcome. */
export const RUN_OUTCOME_ACTION_TYPES: readonly string[] = [
  "web3/write-contract",
  "Write Contract",
];

/** Where a bundle step's write went: sent as a bundle. */
export const BUNDLE_ROUTE = "bundle" as const;

/**
 * Whether this Write Contract call moved no value and cannot still move it:
 * skipped in flight, or a bundle not included with the miss decided. Every
 * other bundle result keeps its own charge, a replay's included: the crashed
 * attempt's reservation lapses, so the replay's must hold the value.
 */
export function bundleMovedNoValue(result: {
  route?: string;
  included?: boolean;
  notIncludedReason?: string;
}): boolean {
  if (result.route === RUN_OUTCOME_OUTPUT.skippedInFlightRoute) {
    return true;
  }
  return (
    result.route === BUNDLE_ROUTE &&
    result.included === false &&
    result.notIncludedReason !== undefined &&
    result.notIncludedReason !== "not-checked"
  );
}
