import { findPythConfig, hashPythConfig } from "./trigger-config";

/** Recheck at consumption and again at runner startup after queue/pod delays. */
export function pythDispatchRefusal(
  nodes: unknown,
  input: Record<string, unknown>,
  now = Date.now()
): string | null {
  if (
    typeof input.expiresAt !== "number" ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= now
  ) {
    return "Pyth signal expired before execution started.";
  }
  try {
    const config = findPythConfig(nodes);
    if (!config || hashPythConfig(config) !== input.configHash) {
      return "Pyth trigger configuration changed before execution started.";
    }
    if (
      input.source !== "pyth-hermes" ||
      input.speculative !== true ||
      input.feedId !== config.feedId
    ) {
      return "Pyth signal does not match this workflow.";
    }
  } catch {
    return "Pyth trigger configuration is invalid.";
  }
  return null;
}
