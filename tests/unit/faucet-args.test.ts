/**
 * Unit tests for bindFaucetArgs.
 *
 * Pure function -- no DB, no RPC, no env. Locks in the case-insensitive
 * name conventions that `tests/e2e/vitest/protocol-coverage/_shared/funding.ts::
 * ensureErc20Acquired` relies on when it calls FAUCETS[*].functionName.
 */

import { describe, expect, it } from "vitest";
import {
  type AbiFunction,
  bindFaucetArgs,
} from "@/tests/e2e/vitest/protocol-coverage/_shared/funding";

const aaveShape: AbiFunction = {
  type: "function",
  name: "mint",
  stateMutability: "nonpayable",
  inputs: [
    { name: "token", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
  ],
};

const fusdcShape: AbiFunction = {
  type: "function",
  name: "mint",
  stateMutability: "nonpayable",
  inputs: [
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
  ],
};

const TOKEN = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
// tsconfig.json targets ES2017; BigInt literals (200n) need ES2020+.
// Compose the value via BigInt() so the file type-checks under the
// project-wide target.
const AMOUNT = BigInt(200) * BigInt(10) ** BigInt(18);

describe("bindFaucetArgs", () => {
  it("binds Aave-style mint(token, to, amount) in declaration order", () => {
    expect(bindFaucetArgs(aaveShape, TOKEN, RECIPIENT, AMOUNT)).toEqual([
      TOKEN,
      RECIPIENT,
      AMOUNT,
    ]);
  });

  it("binds FUSDC-style mint(to, amount) without a token arg", () => {
    expect(bindFaucetArgs(fusdcShape, TOKEN, RECIPIENT, AMOUNT)).toEqual([
      RECIPIENT,
      AMOUNT,
    ]);
  });

  it("matches names case-insensitively", () => {
    const upper: AbiFunction = {
      ...aaveShape,
      inputs: [
        { name: "Token", type: "address" },
        { name: "TO", type: "address" },
        { name: "Amount", type: "uint256" },
      ],
    };
    expect(bindFaucetArgs(upper, TOKEN, RECIPIENT, AMOUNT)).toEqual([
      TOKEN,
      RECIPIENT,
      AMOUNT,
    ]);
  });

  it("accepts `recipient` as an alias for `to`", () => {
    const alias: AbiFunction = {
      ...fusdcShape,
      inputs: [
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    };
    expect(bindFaucetArgs(alias, TOKEN, RECIPIENT, AMOUNT)).toEqual([
      RECIPIENT,
      AMOUNT,
    ]);
  });

  it("accepts `value` as an alias for `amount`", () => {
    const alias: AbiFunction = {
      ...fusdcShape,
      inputs: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
      ],
    };
    expect(bindFaucetArgs(alias, TOKEN, RECIPIENT, AMOUNT)).toEqual([
      RECIPIENT,
      AMOUNT,
    ]);
  });

  it("throws with the offending input name when one isn't recognised", () => {
    const odd: AbiFunction = {
      ...fusdcShape,
      inputs: [
        { name: "_recipient", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    };
    expect(() => bindFaucetArgs(odd, TOKEN, RECIPIENT, AMOUNT)).toThrowError(
      /_recipient/
    );
  });

  it("preserves declared input order even when names are swapped", () => {
    // Catches a regression where the binder sorts inputs alphabetically
    // or otherwise reorders them: the produced args MUST follow the ABI's
    // declared order so the on-chain call signature matches.
    const swapped: AbiFunction = {
      type: "function",
      name: "mint",
      inputs: [
        { name: "amount", type: "uint256" },
        { name: "to", type: "address" },
      ],
    };
    expect(bindFaucetArgs(swapped, TOKEN, RECIPIENT, AMOUNT)).toEqual([
      AMOUNT,
      RECIPIENT,
    ]);
  });
});
