import "server-only";

import {
  isSolidityArrayType,
  normalizeProtocolArrayValue,
} from "@/lib/protocol-array-value";
import { getProtocol, type ProtocolActionInput } from "@/lib/protocol-registry";

export type BuildProtocolFunctionArgsResult =
  | { ok: true; functionArgs: string | undefined }
  | { ok: false; error: string; field: string };

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function resolveInputValue(
  inp: ProtocolActionInput,
  raw: unknown
): { ok: true; value: unknown } | { ok: false; error: string; field: string } {
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
      return {
        ok: true,
        value: normalizeProtocolArrayValue(String(inp.default), inp.type),
      };
    }
    return { ok: true, value: "" };
  }

  // An array input keeps its elements: flattening it to a string leaves
  // ethers with text where it expects an array.
  if (isSolidityArrayType(inp.type)) {
    return { ok: true, value: normalizeProtocolArrayValue(raw, inp.type) };
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

  const args: unknown[] = [];
  for (const inp of protocolAction.inputs) {
    const resolved = resolveInputValue(inp, input[inp.name]);
    if (!resolved.ok) {
      return resolved;
    }
    args.push(resolved.value);
  }

  return { ok: true, functionArgs: JSON.stringify(args) };
}
