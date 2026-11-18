// Direct execution (execute_protocol_action, POST /api/execute/{protocol}/{slug})
// builds its args in buildProtocolFunctionArgs, not in the workflow step. The
// docs say a Solidity bool takes JSON true/false or the two strings, so this
// runs each through the same arg pipeline writeContractCore applies and
// decodes the calldata.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildProtocolFunctionArgs } from "@/app/api/execute/_lib/protocol-function-args";
import { coerceArgsForAbi, reshapeArgsForAbi } from "@/lib/abi/struct-args";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import { fragmentFor, ifaceFor } from "@/lib/test-data/encode-action";
import aaveDef from "@/protocols/aave-v3";

registerProtocol(aaveDef);

const ASSET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const FUNCTION = "setUserUseReserveAsCollateral";

function encodedFlag(useAsCollateral: unknown): boolean {
  const result = buildProtocolFunctionArgs(
    { asset: ASSET, useAsCollateral },
    "aave-v3",
    "pool",
    FUNCTION,
    "1"
  );
  if (!result.ok) {
    throw new Error(`${result.field}: ${result.error}`);
  }
  const protocol = getProtocol("aave-v3");
  const action = protocol?.actions.find((a) => a.function === FUNCTION);
  if (!(protocol && action)) {
    throw new Error(`aave-v3 ${FUNCTION} not registered`);
  }
  const iface = ifaceFor(protocol, action);
  const { abi } = fragmentFor(iface, action);
  // What writeContractCore does with functionArgs before it encodes.
  const parsed = JSON.parse(result.functionArgs ?? "[]") as unknown[];
  const args = coerceArgsForAbi(reshapeArgsForAbi(parsed, abi), abi);
  const decoded = iface.decodeFunctionData(
    FUNCTION,
    iface.encodeFunctionData(FUNCTION, args)
  );
  return decoded[1] as boolean;
}

describe("direct execution of a Solidity bool param", () => {
  it.each([
    [true, true],
    [false, false],
    ["true", true],
    ["false", false],
  ])("encodes %j as %j", (sent, expected) => {
    expect(encodedFlag(sent)).toBe(expected);
  });
});
