/**
 * Evaluates a `showWhen` field predicate against the current config.
 *
 * Supports four variants:
 *   1. { field, equals }       - simple equality against a stored field
 *   2. { field, oneOf }        - membership against a stored field
 *   3. { computed, ... }       - live-derived value (no persistence)
 *   4. { all: [...] }          - every listed predicate holds
 *
 * `all` exists because a hidden field keeps its stored value: a field that
 * depends on `format` alone would still render after the operation that owns
 * `format` is switched away. Gating on the operation as well closes that.
 *
 * The computed variant is how we express "render this field only when
 * another field's derived property matches" without persisting the
 * derived value in the workflow config. Add new kinds by extending the
 * ShowWhen union below and the switch in `evaluateComputed`.
 *
 * Every computed kind must be total: this runs on each render of a node's
 * config form and while assembling the AI prompt's example configs, where a
 * field holds placeholder text rather than a real value.
 */
import { deriveStateMutability } from "@/lib/abi/mutability";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { isSponsorshipSupported } from "@/lib/web3/sponsorship-chains-meta";

export type ShowWhen =
  | { field: string; equals: string }
  | { field: string; oneOf: string[] }
  | {
      computed: "abiFunctionMutability";
      abiField: string;
      functionField: string;
      equals: string;
    }
  | { computed: "sponsorshipSupported"; networkField: string }
  | { all: ShowWhen[] };

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
  if (showWhen.computed === "sponsorshipSupported") {
    const network = config[showWhen.networkField];
    if (typeof network !== "string" && typeof network !== "number") {
      return false;
    }
    try {
      return isSponsorshipSupported(getChainIdFromNetwork(network));
    } catch {
      // An unset or unrecognised network cannot be sponsored, and
      // getChainIdFromNetwork throws rather than returning a sentinel.
      return false;
    }
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
  if ("all" in showWhen) {
    return showWhen.all.every((predicate) =>
      evaluateShowWhen(predicate, config)
    );
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
