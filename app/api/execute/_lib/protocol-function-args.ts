import "server-only";

import {
  PAYER_PLACEHOLDER,
  payerParamOf,
  refuseSuppliedPayer,
} from "@/lib/execute/protocol-payer";
import {
  applyEncodeTransformsNamed,
  getEncodeTransformKind,
} from "@/lib/protocol-encode-transforms";
import { getProtocol, type ProtocolActionInput } from "@/lib/protocol-registry";

// A 20-byte hex address, checksum-insensitive. Checked BEFORE the encode
// transforms run: padAddressToBytes left-pads whatever it is given to 32
// bytes, so a 39-character typo or a bare "0x" would come out as a
// well-formed bytes32 (a wrong address, or the zero address) and broadcast,
// where the untransformed value would have been rejected by the ABI encoder.
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// An already-encoded bytes32. Before this route applied any transform, a
// bytes32 param could only be satisfied by sending the 32-byte value
// itself (ethers rejects a 20-byte value for a bytes32 slot), so every
// caller that works on the CCIP receiver or a LayerZero recipient today
// sends this shape. It stays accepted: padAddressToBytes leaves 64 hex
// characters untouched, so the calldata is byte-identical to before.
const HEX_BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export type BuildProtocolFunctionArgsResult =
  | { ok: true; functionArgs: string | undefined; payerParam?: string }
  | { ok: false; error: string; field: string };

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function resolveInputValue(
  inp: ProtocolActionInput,
  raw: unknown
): { ok: true; value: string } | { ok: false; error: string; field: string } {
  // Match buildInputField in lib/protocol-registry.ts:
  // isRequired = required ?? (default === undefined). Reject blank required
  // fields first; apply registry defaults only for optional blanks.
  const isRequired = inp.required ?? inp.default === undefined;

  if (isBlank(raw)) {
    if (isRequired) {
      return {
        ok: false,
        field: inp.name,
        error: `Missing required field: ${inp.name}`,
      };
    }
    if (inp.default !== undefined) {
      return { ok: true, value: String(inp.default) };
    }
    return { ok: true, value: "" };
  }

  if (typeof raw === "object") {
    return { ok: true, value: JSON.stringify(raw) };
  }
  return { ok: true, value: String(raw) };
}

/**
 * Resolve protocol action ABI args for the direct-execute catch-all route.
 * Applies registry defaults for blank fields and rejects required fields that
 * are missing or empty instead of coercing them to "".
 *
 * Then applies the same per-input encode transforms the workflow step runs
 * (plugins/protocol/steps/protocol-write.ts, buildFunctionArgs), so a field
 * the form collects in one shape and the ABI takes in another - a LayerZero
 * recipient typed as an address but sent as bytes32 - encodes identically
 * whichever entrance the call came through. An action with no registered
 * transform is untouched.
 */
export function buildProtocolFunctionArgs(
  input: Record<string, unknown>,
  protocolSlug: string,
  contractKey: string,
  functionName: string
): BuildProtocolFunctionArgsResult {
  const protocol = getProtocol(protocolSlug);
  if (!protocol) {
    return { ok: true, functionArgs: undefined };
  }

  const protocolAction = protocol.actions.find(
    (a) => a.function === functionName && a.contract === contractKey
  );

  // A payer argument (the OFT send's refundAddress) is assigned by the
  // core write to the resolved paying address, so a caller-supplied value
  // is refused rather than silently overwritten.
  const refusedPayer = refuseSuppliedPayer(protocolAction, input);
  if (refusedPayer) {
    return { ok: false, error: refusedPayer.error, field: refusedPayer.field };
  }

  if (!protocolAction || protocolAction.inputs.length === 0) {
    return { ok: true, functionArgs: undefined };
  }

  const named: Array<{ name: string; value: string }> = [];
  for (const inp of protocolAction.inputs) {
    if (inp.payer) {
      // The placeholder keeps the payer arg's position; writeContractCore
      // writes the paying address over it after it resolves the signer.
      named.push({ name: inp.name, value: PAYER_PLACEHOLDER });
      continue;
    }
    const resolved = resolveInputValue(inp, input[inp.name]);
    if (!resolved.ok) {
      return resolved;
    }
    // An input a pad transform is registered on takes either a 20-byte
    // address (padded below) or an already-encoded bytes32 (passed through,
    // which is what the route did for it before it applied transforms).
    // Any other shape - 39, 41, 63 or 65 hex characters, a bare 0x, non-hex
    // - is refused here, before the pad can make it look well-formed.
    // An address-typed input with no transform takes a 20-byte address
    // only, which is what the ABI encoder enforced for it before.
    const isPadded =
      getEncodeTransformKind(protocolSlug, protocolAction.slug, inp.name) ===
      "padAddressToBytes";
    const value = resolved.value;
    if (isPadded && value !== "") {
      if (!(HEX_ADDRESS.test(value) || HEX_BYTES32.test(value))) {
        return {
          ok: false,
          field: inp.name,
          error: `Invalid address for field ${inp.name}: expected a 0x-prefixed 20-byte hex address (or the same address already encoded as 32 bytes), got "${value}"`,
        };
      }
    } else if (
      inp.type === "address" &&
      value !== "" &&
      !HEX_ADDRESS.test(value)
    ) {
      return {
        ok: false,
        field: inp.name,
        error: `Invalid address for field ${inp.name}: expected a 0x-prefixed 20-byte hex address, got "${value}"`,
      };
    }
    named.push({ name: inp.name, value: resolved.value });
  }

  const transformed = applyEncodeTransformsNamed(
    protocolSlug,
    protocolAction.slug,
    named
  );

  return {
    ok: true,
    functionArgs: JSON.stringify(transformed.map((t) => t.value)),
    payerParam: payerParamOf(protocolAction),
  };
}
