/**
 * Evaluates a `showWhen` field predicate against the current config.
 *
 * Supports three variants:
 *   1. { field, equals }       - simple equality against a stored field
 *   2. { field, oneOf }        - membership against a stored field
 *   3. { computed, ... }       - live-derived value (no persistence)
 *
 * The computed variant is how we express "render this field only when
 * another field's derived property matches" without persisting the
 * derived value in the workflow config. Today only "abiFunctionMutability"
 * is supported; add new kinds by extending the union in plugins/registry.ts
 * and the switch in `evaluateComputed`.
 */
import { deriveStateMutability } from "@/lib/web3/abi-mutability";

export type ShowWhen =
  | { field: string; equals: string }
  | { field: string; oneOf: string[] }
  | {
      computed: "abiFunctionMutability";
      abiField: string;
      functionField: string;
      equals: string;
    };

function evaluateComputed(
  showWhen: Extract<ShowWhen, { computed: string }>,
  config: Record<string, unknown>
): boolean {
  if (showWhen.computed === "abiFunctionMutability") {
    const abi = (config[showWhen.abiField] as string | undefined) || "";
    const funcName =
      (config[showWhen.functionField] as string | undefined) || "";
    if (!(abi && funcName)) {
      return false;
    }
    return deriveStateMutability(abi, funcName) === showWhen.equals;
  }
  return false;
}

export function evaluateShowWhen(
  showWhen: ShowWhen | undefined,
  config: Record<string, unknown>
): boolean {
  if (!showWhen) {
    return true;
  }
  if ("computed" in showWhen) {
    return evaluateComputed(showWhen, config);
  }
  const dependentValue = config[showWhen.field];
  if ("oneOf" in showWhen) {
    return showWhen.oneOf.includes(dependentValue as string);
  }
  return dependentValue === showWhen.equals;
}
