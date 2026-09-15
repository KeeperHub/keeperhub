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
 * #2470 moved it here so the routes reuse it rather than re-implement it.
 */

import { ErrorCategory, logUserError } from "@/lib/logging";
import { getEncodeTransform } from "@/lib/protocol-encode-transforms";
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
 * direct API caller can send a JSON number. When the action registers a
 * transform, a safe-integer number or a bigint is taken as that integer's
 * digits and converted; a number that cannot hold its digits exactly (above
 * 2^53, or fractional) is refused rather than rounded into a fee the
 * contract will reject or, worse, accept at the wrong amount. When no
 * transform is registered the value is returned untouched, so every
 * existing action behaves exactly as before.
 */
export function applyEthValueTransform(
  rawEthValue: unknown,
  meta: ProtocolActionRef
): EthValueTransformResult {
  const present =
    (typeof rawEthValue === "string" && rawEthValue.trim() !== "") ||
    typeof rawEthValue === "number" ||
    typeof rawEthValue === "bigint";
  if (!present) {
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
  if (!transform) {
    return { ok: true, value: rawEthValue };
  }
  if (typeof rawEthValue === "string") {
    return { ok: true, value: transform(rawEthValue.trim()) };
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
