import { describe, expect, it } from "vitest";

import { evaluateShowWhen } from "@/lib/workflow/editor/show-when";

const PAYABLE_ABI = JSON.stringify([
  {
    type: "function",
    name: "deposit",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
]);

describe("evaluateShowWhen", () => {
  describe("no predicate", () => {
    it("returns true when showWhen is undefined", () => {
      expect(evaluateShowWhen(undefined, {})).toBe(true);
    });
  });

  describe("equals variant", () => {
    it("returns true when the field matches", () => {
      expect(
        evaluateShowWhen(
          { field: "mode", equals: "advanced" },
          { mode: "advanced" }
        )
      ).toBe(true);
    });

    it("returns false when the field does not match", () => {
      expect(
        evaluateShowWhen(
          { field: "mode", equals: "advanced" },
          { mode: "basic" }
        )
      ).toBe(false);
    });

    it("returns false when the field is absent", () => {
      expect(evaluateShowWhen({ field: "mode", equals: "advanced" }, {})).toBe(
        false
      );
    });
  });

  describe("oneOf variant", () => {
    it("returns true when the field is in the set", () => {
      expect(
        evaluateShowWhen(
          { field: "mode", oneOf: ["a", "b", "c"] },
          { mode: "b" }
        )
      ).toBe(true);
    });

    it("returns false when the field is not in the set", () => {
      expect(
        evaluateShowWhen(
          { field: "mode", oneOf: ["a", "b", "c"] },
          { mode: "z" }
        )
      ).toBe(false);
    });
  });

  describe("all variant", () => {
    const predicate = {
      all: [
        { field: "operation", oneOf: ["encode", "decode"] },
        { field: "format", oneOf: ["bytes32", "bytes16", "bytes8"] },
      ],
    };

    it("returns true when every predicate holds", () => {
      expect(
        evaluateShowWhen(predicate, { operation: "encode", format: "bytes32" })
      ).toBe(true);
    });

    it("returns false when one predicate fails", () => {
      expect(
        evaluateShowWhen(predicate, { operation: "encode", format: "hex" })
      ).toBe(false);
    });

    it("keeps a field hidden when its sibling is hidden but still stored", () => {
      // The format field is hidden for a numeric operation, yet its stored
      // value survives. Gating on the operation too keeps padding hidden.
      expect(
        evaluateShowWhen(predicate, {
          operation: "decimal-to-hex",
          format: "bytes32",
        })
      ).toBe(false);
    });

    it("returns true for an empty list", () => {
      expect(evaluateShowWhen({ all: [] }, {})).toBe(true);
    });

    it("nests with the computed variant", () => {
      expect(
        evaluateShowWhen(
          {
            all: [
              { field: "mode", equals: "advanced" },
              {
                computed: "abiFunctionMutability",
                abiField: "abi",
                functionField: "abiFunction",
                equals: "payable",
              },
            ],
          },
          { mode: "advanced", abi: PAYABLE_ABI, abiFunction: "deposit" }
        )
      ).toBe(true);
    });
  });

  describe("computed: abiFunctionMutability", () => {
    const predicate = {
      computed: "abiFunctionMutability" as const,
      abiField: "abi",
      functionField: "abiFunction",
      equals: "payable",
    };

    it("returns true when the selected function is payable", () => {
      expect(
        evaluateShowWhen(predicate, {
          abi: PAYABLE_ABI,
          abiFunction: "deposit",
        })
      ).toBe(true);
    });

    it("returns false when the selected function is not payable", () => {
      expect(
        evaluateShowWhen(predicate, {
          abi: PAYABLE_ABI,
          abiFunction: "withdraw",
        })
      ).toBe(false);
    });

    it("returns false when the ABI is missing", () => {
      expect(evaluateShowWhen(predicate, { abiFunction: "deposit" })).toBe(
        false
      );
    });

    it("returns false when the function is missing", () => {
      expect(evaluateShowWhen(predicate, { abi: PAYABLE_ABI })).toBe(false);
    });

    it("returns false when the ABI is malformed (fails closed)", () => {
      expect(
        evaluateShowWhen(predicate, {
          abi: "not json",
          abiFunction: "deposit",
        })
      ).toBe(false);
    });

    it("re-evaluates live: swapping the ABI flips the result without any persisted cache", () => {
      const nonPayableAbi = JSON.stringify([
        {
          type: "function",
          name: "deposit",
          inputs: [],
          outputs: [],
          stateMutability: "nonpayable",
        },
      ]);
      // Same function name, different ABI -> must reflect new mutability
      // immediately. This is the drift case that the prior persisted
      // _abiStateMutability implementation got wrong.
      expect(
        evaluateShowWhen(predicate, {
          abi: PAYABLE_ABI,
          abiFunction: "deposit",
        })
      ).toBe(true);
      expect(
        evaluateShowWhen(predicate, {
          abi: nonPayableAbi,
          abiFunction: "deposit",
        })
      ).toBe(false);
    });
  });

  describe("computed: sponsorshipSupported", () => {
    const predicate = {
      computed: "sponsorshipSupported",
      networkField: "network",
    } as const;

    it("shows the field on a chain the Gas Station covers", () => {
      // The chain select stores String(chainId); 1 is Ethereum, 84532 Base Sepolia.
      expect(evaluateShowWhen(predicate, { network: "1" })).toBe(true);
      expect(evaluateShowWhen(predicate, { network: "84532" })).toBe(true);
    });

    it("hides the field on an EVM chain the Gas Station does not cover", () => {
      // Optimism and BNB are deliberately absent from SPONSORSHIP_CHAINS, so a
      // toggle there could only turn off something that was never available.
      expect(evaluateShowWhen(predicate, { network: "10" })).toBe(false);
      expect(evaluateShowWhen(predicate, { network: "56" })).toBe(false);
    });

    it("hides the field on a Solana network", () => {
      // Transfer Native Token accepts Solana, and its step returns before the
      // sponsorship gate is reached.
      // SOLANA_MAINNET / SOLANA_DEVNET in lib/rpc/types.ts.
      expect(evaluateShowWhen(predicate, { network: "101" })).toBe(false);
      expect(evaluateShowWhen(predicate, { network: "103" })).toBe(false);
    });

    it("resolves a legacy network name, not just a numeric id", () => {
      expect(evaluateShowWhen(predicate, { network: "mainnet" })).toBe(true);
      expect(evaluateShowWhen(predicate, { network: "base" })).toBe(true);
    });

    it("hides the field rather than throwing when the network is unusable", () => {
      // getChainIdFromNetwork throws on these. buildExampleConfig seeds the
      // network field with placeholder text ("Your network") when assembling the
      // AI prompt, and this runs on every render of the config form.
      expect(evaluateShowWhen(predicate, {})).toBe(false);
      expect(evaluateShowWhen(predicate, { network: "" })).toBe(false);
      expect(evaluateShowWhen(predicate, { network: "Your network" })).toBe(
        false
      );
      expect(evaluateShowWhen(predicate, { network: null })).toBe(false);
      expect(evaluateShowWhen(predicate, { network: {} })).toBe(false);
    });
  });
});
