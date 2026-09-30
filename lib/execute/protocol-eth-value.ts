/**
 * The one place a protocol action's payable value is converted into the
 * ether string the core write expects.
 *
 * Every entrance that broadcasts a protocol write or reserves its value
 * against the daily cap has to run the same conversion, or they disagree by
 * 10^18 on an action whose value field is typed in wei: the workflow step
 * (plugins/protocol/steps/protocol-write.ts), the direct-execute catch-all
 * route (app/api/execute/[...slug]/route.ts), the generic node route's cap
 * reservation (app/api/execute/node/route.ts) and the calldata harness
 * (lib/test-data/encode-action.ts). #2322 added the conversion to the step;
 * #2470 moved it here so the routes and the harness call it rather than
 * re-implement it.
 */

import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  getEncodeTransform,
  getEncodeTransformKind,
} from "@/lib/protocol-encode-transforms";
import { getProtocol, type ProtocolAction } from "@/lib/protocol-registry";

/** The identity every entrance resolves before it can look the action up. */
export type ProtocolActionRef = {
  protocolSlug: string;
  contractKey: string;
  functionName: string;
};

/**
 * Resolve the registered action a protocol write is executing. One lookup
 * rule for the args builder and the value transform, so the two cannot
 * drift: the pair (contract, function) is unique per protocol (pinned by
 * tests/unit/protocol-encode-transform-invariants.test.ts).
 */
export function findProtocolAction(
  meta: ProtocolActionRef
): ProtocolAction | undefined {
  return getProtocol(meta.protocolSlug)?.actions.find(
    (a) => a.function === meta.functionName && a.contract === meta.contractKey
  );
}

/**
 * The raw payable value a protocol write carries, before any unit
 * transform. An action that declares payableValue.fromInput (LayerZero's
 * OFT send takes msg.value from nativeFee) reads that input, so the value
 * and the declared fee cannot disagree. A caller that still sends a
 * separate ethValue must send the same number, or the write is refused.
 * Every other action reads ethValue as before.
 *
 * The fromInput pairing is only safe when the action also registers the
 * weiToEther conversion on the virtual ethValue field: the input is an
 * integer in wei and the field reads ether, so without the transform the
 * core would be handed 10^18 times the intent. An action in that state is
 * refused here rather than paid.
 */
export function readPayableValue(
  source: Record<string, unknown>,
  meta: ProtocolActionRef
): { ok: true; value: unknown; field: string } | { ok: false; error: string } {
  const action = findProtocolAction(meta);
  const fromInput = action?.payableValue?.fromInput;
  if (!(action && fromInput)) {
    return { ok: true, value: source.ethValue, field: "ethValue" };
  }
  if (
    getEncodeTransformKind(meta.protocolSlug, action.slug, "ethValue") !==
    "weiToEther"
  ) {
    return {
      ok: false,
      error: `Refusing to send a payable value: this action takes its value from "${fromInput}", an integer input, but registers no weiToEther conversion for it, so the value cannot be converted to ether safely.`,
    };
  }
  const derived = source[fromInput];
  const explicit = source.ethValue;
  const blank = (v: unknown) =>
    v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  if (
    !blank(explicit) &&
    String(explicit).trim() !== String(derived ?? "").trim()
  ) {
    return {
      ok: false,
      error: `Refusing to send a payable value: this action takes its value from "${fromInput}", and the separate ethValue (${String(explicit)}) differs from it. Remove ethValue or make it equal to ${fromInput}.`,
    };
  }
  return { ok: true, value: derived, field: fromInput };
}

export type EthValueTransformResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function refuseUnresolvable(meta: ProtocolActionRef): EthValueTransformResult {
  // Logged as well as returned: this turns a previously-succeeding
  // execution into a hard failure for a payable action whose stored
  // protocol metadata has drifted, and without a log the affected nodes
  // are only findable when a user reports one.
  logUserError(
    ErrorCategory.CONFIGURATION,
    `[Protocol Write] Refused a payable value: no action matches function '${meta.functionName}' on contract '${meta.contractKey}' in protocol '${meta.protocolSlug}'`,
    undefined,
    {
      plugin_name: "protocol",
      action_name: "protocol-write",
      protocol_slug: meta.protocolSlug,
      function_name: meta.functionName,
      contract_key: meta.contractKey,
    }
  );
  return {
    ok: false,
    error: `Refusing to send a payable value: no action matches function "${meta.functionName}" on contract "${meta.contractKey}" in protocol "${meta.protocolSlug}", so whether the ETH Value field needs a unit conversion cannot be determined. This usually means the step's stored protocol metadata is stale - re-select the action on this node.`,
  };
}

/**
 * Apply the transform registered under the virtual input name "ethValue"
 * for the action `meta` resolves to. The value field is not an ABI input,
 * so the per-input transform pass never sees it; callers run this before
 * anything reads the value - the cap reservation and the core write - so
 * both consumers see the same converted string. The documented unit of the
 * field stays ether; a registered transform converts into it.
 *
 * Fails closed on an unresolvable action, and that is the point. `meta` is
 * typically cast out of an unvalidated JSON.parse of a node's stored
 * `_protocolMeta`, so a contractKey or functionName that no longer matches
 * a registered action resolves to nothing. Passing the value through in
 * that case would hand parseEther a raw wei integer and read it as ether -
 * 10^18 times the intended amount. The daily-value cap normally refuses
 * such a number, but value-ledger.ts runs uncapped when a reservation is
 * already held or the organizationId is absent, so on those paths it would
 * reach the wallet and fail only on balance. Without the action there is no
 * safe default, so refuse rather than guess.
 *
 * Non-string values. A workflow's template substitution stringifies, but a
 * direct API caller can send a JSON number. Only where a transform actually
 * applies - the action resolves and registers one - is a number touched: a
 * safe-integer number or a bigint is taken as that integer's digits and
 * converted, and a number that cannot hold its digits exactly (above 2^53,
 * or fractional) is refused rather than rounded into a fee the contract
 * will reject or, worse, accept at the wrong amount. Everywhere else a
 * non-string is returned untouched, so an action with no transform, and an
 * unresolvable action given a number, behave exactly as before this helper
 * existed (the step drops the value, the route stringifies it). The
 * fail-closed refusal is for the case #2322 defined it for: a non-empty
 * string value on an action that cannot be resolved.
 */
export function applyEthValueTransform(
  rawEthValue: unknown,
  meta: ProtocolActionRef
): EthValueTransformResult {
  if (typeof rawEthValue === "string") {
    if (rawEthValue.trim() === "") {
      return { ok: true, value: rawEthValue };
    }
    const protocolAction = findProtocolAction(meta);
    if (!protocolAction) {
      return refuseUnresolvable(meta);
    }
    const transform = getEncodeTransform(
      meta.protocolSlug,
      protocolAction.slug,
      "ethValue"
    );
    return {
      ok: true,
      value: transform ? transform(rawEthValue.trim()) : rawEthValue,
    };
  }
  if (typeof rawEthValue !== "number" && typeof rawEthValue !== "bigint") {
    return { ok: true, value: rawEthValue };
  }
  const protocolAction = findProtocolAction(meta);
  const transform = protocolAction
    ? getEncodeTransform(meta.protocolSlug, protocolAction.slug, "ethValue")
    : undefined;
  if (!transform) {
    return { ok: true, value: rawEthValue };
  }
  if (typeof rawEthValue === "number" && !Number.isSafeInteger(rawEthValue)) {
    return {
      ok: false,
      error: `Refusing to send a payable value: ethValue ${String(rawEthValue)} is a JSON number that cannot carry an exact integer wei amount. Send the wei value as a string.`,
    };
  }
  // A safe-integer number or a bigint: String() yields its exact digits,
  // which is the integer wei string the transform expects.
  return { ok: true, value: transform(String(rawEthValue)) };
}
