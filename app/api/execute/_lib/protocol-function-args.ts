import "server-only";

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

export type BuildProtocolFunctionArgsResult =
  | { ok: true; functionArgs: string | undefined }
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

  if (!protocolAction || protocolAction.inputs.length === 0) {
    return { ok: true, functionArgs: undefined };
  }

  const named: Array<{ name: string; value: string }> = [];
  for (const inp of protocolAction.inputs) {
    const resolved = resolveInputValue(inp, input[inp.name]);
    if (!resolved.ok) {
      return resolved;
    }
    // Every input the form collects as an address, and every input a pad
    // transform is registered on whatever its declared type, must be a real
    // address before the pad can make it look like one.
    const mustBeAddress =
      inp.type === "address" ||
      getEncodeTransformKind(protocolSlug, protocolAction.slug, inp.name) ===
        "padAddressToBytes";
    if (
      mustBeAddress &&
      resolved.value !== "" &&
      !HEX_ADDRESS.test(resolved.value)
    ) {
      return {
        ok: false,
        field: inp.name,
        error: `Invalid address for field ${inp.name}: expected a 0x-prefixed 20-byte hex address, got "${resolved.value}"`,
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
  };
}
