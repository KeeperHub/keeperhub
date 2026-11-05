// Refusal reasons and texts, without server-only, so the standalone executor
// writes the same reason code and message as the app routes.

export type DispatchRefusalReason = "plan_feature" | "execution_limit";

export type DispatchRefusal = {
  reason: DispatchRefusalReason;
  message: string;
};

export const EXECUTION_LIMIT_REFUSAL =
  "Execution skipped: your plan's monthly execution limit has been reached.";

export function planFeatureRefusalMessage(
  featureNames: readonly string[]
): string {
  return `Workflow uses features that require a paid plan: ${featureNames.join(", ")}`;
}
