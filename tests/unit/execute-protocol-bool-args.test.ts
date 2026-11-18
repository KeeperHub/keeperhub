// Direct execution (execute_protocol_action, POST /api/execute/{protocol}/{slug})
// builds its args in buildProtocolFunctionArgs, not in the workflow step. The
// docs say a Solidity bool takes JSON true/false or the two strings, so this
// runs each through the same arg pipeline writeContractCore applies and
// decodes the calldata.

import { Interface } from "ethers";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildProtocolFunctionArgs } from "@/app/api/execute/_lib/protocol-function-args";
import {
  coerceArgsForAbi,
  type FunctionAbiEntry,
  reshapeArgsForAbi,
} from "@/lib/abi/struct-args";
import { registerProtocol } from "@/lib/protocol-registry";
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
  const abi = JSON.parse(aaveDef.contracts.pool.abi ?? "[]") as Array<
    FunctionAbiEntry & { name?: string }
  >;
  const entry = abi.find((item) => item.name === FUNCTION);
  if (!entry) {
    throw new Error(`${FUNCTION} not in the pool ABI`);
  }
  // What writeContractCore does with functionArgs before it encodes.
  const parsed = JSON.parse(result.functionArgs ?? "[]") as unknown[];
  const args = coerceArgsForAbi(reshapeArgsForAbi(parsed, entry), entry);
  const iface = new Interface(abi);
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
