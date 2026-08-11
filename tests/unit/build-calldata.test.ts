/**
 * Unit tests for the shared on-chain integration test helper.
 *
 * These cover the helper's branching logic (toOverride fallback,
 * coerceArgs gating) and error paths without requiring a live RPC, so
 * regressions are caught in the test-unit CI job even when the on-chain
 * integration suites skip.
 */

import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import type { ProtocolDefinition } from "@/lib/protocol-registry";
import { buildCalldata } from "../integration/_shared/build-calldata";

const TEST_ADDRESS = "0x0000000000000000000000000000000000000001";
const OVERRIDE_ADDRESS = "0x000000000000000000000000000000000000DEAD";
const FOO_ADDRESS = "0x000000000000000000000000000000000000F00D";
const NOABI_ADDRESS = "0x000000000000000000000000000000000000ABCD";

const BALANCE_OF_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setFlag",
    stateMutability: "nonpayable",
    inputs: [{ name: "flag", type: "bool" }],
    outputs: [],
  },
]);

const fixture: ProtocolDefinition = {
  name: "Fixture",
  slug: "fixture",
  description: "Synthetic protocol for buildCalldata unit tests.",
  contracts: {
    token: {
      label: "Token",
      addresses: { "1": FOO_ADDRESS },
      abi: BALANCE_OF_ABI,
    },
    userToken: {
      label: "User-supplied Token",
      addresses: {},
      abi: BALANCE_OF_ABI,
      userSpecifiedAddress: true,
    },
    noAbi: {
      label: "No ABI",
      addresses: { "1": NOABI_ADDRESS },
    },
  },
  actions: [
    {
      slug: "balance-of",
      label: "Balance Of",
      description: "ERC20 balanceOf",
      type: "read",
      contract: "token",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Account" }],
    },
    {
      slug: "balance-of-user-token",
      label: "Balance Of (User Token)",
      description: "balanceOf against a user-supplied contract",
      type: "read",
      contract: "userToken",
      function: "balanceOf",
      inputs: [{ name: "account", type: "address", label: "Account" }],
    },
    {
      slug: "set-flag",
      label: "Set Flag",
      description: "Toggle a bool",
      type: "write",
      contract: "token",
      function: "setFlag",
      inputs: [{ name: "flag", type: "bool", label: "Flag" }],
    },
    {
      slug: "no-abi-action",
      label: "No ABI",
      description: "Action on a contract without an ABI",
      type: "read",
      contract: "noAbi",
      function: "balanceOf",
      inputs: [],
    },
    {
      slug: "unknown-function",
      label: "Unknown Function",
      description: "Action whose function is not in the ABI",
      type: "read",
      contract: "token",
      function: "doesNotExist",
      inputs: [],
    },
  ],
};

const iface = new ethers.Interface(BALANCE_OF_ABI);

describe("buildCalldata", () => {
  describe("address resolution", () => {
    it("resolves to addresses[chainId] when no toOverride", () => {
      const result = buildCalldata({
        protocol: fixture,
        actionSlug: "balance-of",
        sampleInputs: { account: TEST_ADDRESS },
        chainId: "1",
      });
      expect(result.to).toBe(FOO_ADDRESS);
    });

    it("toOverride takes precedence over addresses[chainId]", () => {
      const result = buildCalldata({
        protocol: fixture,
        actionSlug: "balance-of",
        sampleInputs: { account: TEST_ADDRESS },
        chainId: "1",
        toOverride: OVERRIDE_ADDRESS,
      });
      expect(result.to).toBe(OVERRIDE_ADDRESS);
    });

    it("toOverride supplies the address for userSpecifiedAddress contracts", () => {
      const result = buildCalldata({
        protocol: fixture,
        actionSlug: "balance-of-user-token",
        sampleInputs: { account: TEST_ADDRESS },
        chainId: "1",
        toOverride: OVERRIDE_ADDRESS,
      });
      expect(result.to).toBe(OVERRIDE_ADDRESS);
    });
  });

  describe("calldata encoding", () => {
    it("encodes the function selector and args via ethers.Interface", () => {
      const result = buildCalldata({
        protocol: fixture,
        actionSlug: "balance-of",
        sampleInputs: { account: TEST_ADDRESS },
        chainId: "1",
      });
      const expected = iface.encodeFunctionData("balanceOf", [TEST_ADDRESS]);
      expect(result.data).toBe(expected);
    });

    it("returns the resolved action and contract for caller assertions", () => {
      const result = buildCalldata({
        protocol: fixture,
        actionSlug: "balance-of",
        sampleInputs: { account: TEST_ADDRESS },
        chainId: "1",
      });
      expect(result.action.slug).toBe("balance-of");
      expect(result.contract.label).toBe("Token");
    });
  });

  describe("coerceArgs option", () => {
    it("defaults to true: 'false' encodes as boolean false (production parity)", () => {
      const result = buildCalldata({
        protocol: fixture,
        actionSlug: "set-flag",
        sampleInputs: { flag: "false" },
        chainId: "1",
      });
      const decoded = iface.decodeFunctionData("setFlag", result.data);
      expect(decoded[0]).toBe(false);
    });

    it("coerceArgs: false documents the trap: 'false' encodes as boolean true", () => {
      // Without coerce, ethers treats any non-empty string as truthy, so
      // the literal "false" round-trips through encodeFunctionData as true.
      // This test pins the production-divergence behavior the option
      // exists to disarm. Pass an explicit flag rather than relying on
      // the default so the test survives a default flip.
      const result = buildCalldata({
        protocol: fixture,
        actionSlug: "set-flag",
        sampleInputs: { flag: "false" },
        chainId: "1",
        coerceArgs: false,
      });
      const decoded = iface.decodeFunctionData("setFlag", result.data);
      expect(decoded[0]).toBe(true);
    });

    it("coerceArgs: true preserves the boolean value of 'false'", () => {
      const result = buildCalldata({
        protocol: fixture,
        actionSlug: "set-flag",
        sampleInputs: { flag: "false" },
        chainId: "1",
        coerceArgs: true,
      });
      const decoded = iface.decodeFunctionData("setFlag", result.data);
      expect(decoded[0]).toBe(false);
    });

    it("coerceArgs: true preserves 'true' as boolean true", () => {
      const result = buildCalldata({
        protocol: fixture,
        actionSlug: "set-flag",
        sampleInputs: { flag: "true" },
        chainId: "1",
        coerceArgs: true,
      });
      const decoded = iface.decodeFunctionData("setFlag", result.data);
      expect(decoded[0]).toBe(true);
    });
  });

  describe("error paths", () => {
    it("throws when the action slug is unknown", () => {
      expect(() =>
        buildCalldata({
          protocol: fixture,
          actionSlug: "nope",
          sampleInputs: {},
          chainId: "1",
        })
      ).toThrow("Action nope not found");
    });

    it("throws when the resolved contract has no ABI", () => {
      expect(() =>
        buildCalldata({
          protocol: fixture,
          actionSlug: "no-abi-action",
          sampleInputs: {},
          chainId: "1",
        })
      ).toThrow("Contract noAbi has no ABI");
    });

    it("throws when the action.function is not declared in the ABI", () => {
      expect(() =>
        buildCalldata({
          protocol: fixture,
          actionSlug: "unknown-function",
          sampleInputs: {},
          chainId: "1",
        })
      ).toThrow("Function doesNotExist not found in ABI for contract token");
    });

    it("throws when sampleInputs contains a key the action does not declare", () => {
      expect(() =>
        buildCalldata({
          protocol: fixture,
          actionSlug: "balance-of",
          sampleInputs: { account: TEST_ADDRESS, accountt: TEST_ADDRESS },
          chainId: "1",
        })
      ).toThrow(
        "Sample input 'accountt' is not declared for action 'balance-of'. Known inputs: account"
      );
    });

    it("throws with '(none)' hint when the action declares no inputs at all", () => {
      expect(() =>
        buildCalldata({
          protocol: fixture,
          actionSlug: "no-abi-action",
          sampleInputs: { stray: "value" },
          chainId: "1",
        })
      ).toThrow(
        "Sample input 'stray' is not declared for action 'no-abi-action'. Known inputs: (none)"
      );
    });

    it("throws with a toOverride hint when no address is found", () => {
      expect(() =>
        buildCalldata({
          protocol: fixture,
          actionSlug: "balance-of",
          sampleInputs: { account: TEST_ADDRESS },
          chainId: "999",
        })
      ).toThrow(
        "No address for contract token on chain 999 and no toOverride given"
      );
    });

    it("throws on userSpecifiedAddress contracts when toOverride is omitted", () => {
      expect(() =>
        buildCalldata({
          protocol: fixture,
          actionSlug: "balance-of-user-token",
          sampleInputs: { account: TEST_ADDRESS },
          chainId: "1",
        })
      ).toThrow(
        "No address for contract userToken on chain 1 and no toOverride given"
      );
    });
  });
});
