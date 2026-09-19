import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AbiItem, findAbiFunction } from "@/lib/abi/utils";
import type { ProtocolAction } from "@/lib/protocol-registry";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import {
  type AbiOutputParam,
  structureAbiOutputs,
} from "@/plugins/web3/steps/structure-abi-result";
import renzoDef from "@/protocols/renzo";
import { checkOutputExpectation } from "@/tests/e2e/vitest/protocol-coverage/_shared/oracle";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

/**
 * Decoded return values observed on Ethereum mainnet over a public RPC on
 * 2026-09-17: `paused()` returned 0x00..00 and ezETH `totalSupply()` returned
 * 0x8c0111289f2afea6b1c. Held as a fixture, BigInt-serialized the way
 * readContractCore records them, so the checks below run in PR CI without an
 * RPC. The balance is a stand-in; only its shape matters.
 */
const DECODED_RETURNS: Record<string, unknown[]> = {
  paused: [false],
  "ez-total-supply": ["41321936922433047653148"],
  "ez-balance-of": ["1000000000000000000"],
};

function findAction(slug: string): ProtocolAction {
  const action = renzoDef.actions.find((a) => a.slug === slug);
  if (!action) {
    throw new Error(`no action "${slug}" on the Renzo definition`);
  }
  return action;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;

/** Width and height read straight out of the PNG IHDR chunk. */
function readPngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${path} is not a PNG`);
  }
  return {
    width: bytes.readUInt32BE(PNG_IHDR_WIDTH_OFFSET),
    height: bytes.readUInt32BE(PNG_IHDR_HEIGHT_OFFSET),
  };
}

/** The `result` a read step records: the raw ABI outputs run through
 *  `structureAbiOutputs`, which is what template paths resolve against. */
function structuredResult(action: ProtocolAction): unknown {
  const abiJson = renzoDef.contracts[action.contract]?.abi;
  if (!abiJson) {
    throw new Error(`contract "${action.contract}" declares no ABI`);
  }
  const fn = findAbiFunction(JSON.parse(abiJson) as AbiItem[], action.function);
  const outputs = (fn?.outputs ?? []) as AbiOutputParam[];
  return structureAbiOutputs(DECODED_RETURNS[action.slug] ?? [], outputs);
}

describe("Renzo Protocol Definition (ABI-driven)", () => {
  it("imports without throwing", () => {
    expect(renzoDef).toBeDefined();
    expect(renzoDef.name).toBe("Renzo");
    expect(renzoDef.slug).toBe("renzo");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(renzoDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of renzoDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(renzoDef.contracts));
    for (const action of renzoDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = renzoDef.actions.map((a) => a.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });

  it("all read actions define outputs", () => {
    const readActions = renzoDef.actions.filter((a) => a.type === "read");
    for (const action of readActions) {
      expect(
        action.outputs,
        `read action "${action.slug}" must have outputs`
      ).toBeDefined();
      expect(action.outputs?.length).toBeGreaterThan(0);
    }
  });

  it("all contract addresses are valid hex format", () => {
    for (const [key, contract] of Object.entries(renzoDef.contracts)) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chain}" address must be valid hex`
        ).toMatch(HEX_ADDRESS_REGEX);
      }
    }
  });

  it("has two contracts (restakeManager, ezeth)", () => {
    expect(Object.keys(renzoDef.contracts).sort()).toEqual([
      "ezeth",
      "restakeManager",
    ]);
    expect(renzoDef.contracts.restakeManager.label).toBe(
      "Renzo Restake Manager"
    );
    expect(renzoDef.contracts.ezeth.label).toBe("ezETH Token");
  });

  it("has 4 actions: 1 write and 3 reads", () => {
    expect(renzoDef.actions).toHaveLength(4);
    const reads = renzoDef.actions.filter((a) => a.type === "read");
    const writes = renzoDef.actions.filter((a) => a.type === "write");
    expect(reads).toHaveLength(3);
    expect(writes).toHaveLength(1);
  });

  it("exposes the expected action slugs", () => {
    const slugs = renzoDef.actions.map((a) => a.slug).sort();
    expect(slugs).toEqual(
      ["ez-balance-of", "ez-total-supply", "paused", "stake"].sort()
    );
  });

  it("stake is a payable write with no inputs on the RestakeManager", () => {
    const stake = renzoDef.actions.find((a) => a.slug === "stake");
    expect(stake).toBeDefined();
    expect(stake?.type).toBe("write");
    expect(stake?.payable).toBe(true);
    expect(stake?.inputs).toHaveLength(0);
    expect(stake?.contract).toBe("restakeManager");
    expect(stake?.function).toBe("depositETH");
    expect(stake?.label).toBe("Stake ETH for ezETH");
  });

  it("paused is a read returning a bool", () => {
    const paused = renzoDef.actions.find((a) => a.slug === "paused");
    expect(paused).toBeDefined();
    expect(paused?.type).toBe("read");
    expect(paused?.payable).toBeUndefined();
    expect(paused?.inputs).toHaveLength(0);
    expect(paused?.function).toBe("paused");
    expect(paused?.outputs).toHaveLength(1);
    expect(paused?.outputs?.[0].name).toBe("paused");
    expect(paused?.outputs?.[0].type).toBe("bool");
  });

  it("ez-total-supply reads an 18-decimal uint256 from ezETH", () => {
    const supply = renzoDef.actions.find((a) => a.slug === "ez-total-supply");
    expect(supply).toBeDefined();
    expect(supply?.type).toBe("read");
    expect(supply?.contract).toBe("ezeth");
    expect(supply?.function).toBe("totalSupply");
    expect(supply?.outputs?.[0].name).toBe("totalSupply");
    expect(supply?.outputs?.[0].type).toBe("uint256");
    expect(supply?.outputs?.[0].decimals).toBe(18);
  });

  it("ez-balance-of takes an address and returns a balance", () => {
    const bal = renzoDef.actions.find((a) => a.slug === "ez-balance-of");
    expect(bal).toBeDefined();
    expect(bal?.type).toBe("read");
    expect(bal?.contract).toBe("ezeth");
    expect(bal?.inputs).toHaveLength(1);
    expect(bal?.inputs[0].type).toBe("address");
    expect(bal?.outputs?.[0].name).toBe("balance");
    expect(bal?.outputs?.[0].decimals).toBe(18);
  });

  it("every contract is Ethereum mainnet only (chain 1)", () => {
    for (const contract of Object.values(renzoDef.contracts)) {
      expect(Object.keys(contract.addresses)).toEqual(["1"]);
    }
  });

  it("excludes Sepolia, Holesky, Goerli, Base and Arbitrum", () => {
    const excluded = ["11155111", "17000", "5", "8453", "42161"];
    for (const contract of Object.values(renzoDef.contracts)) {
      for (const chainId of excluded) {
        expect(
          contract.addresses[chainId],
          `contract must not be deployed on chain ${chainId}`
        ).toBeUndefined();
      }
    }
  });

  it("contract addresses match the verified mainnet deployments", () => {
    // Verified on-chain 2026-09-10: ezETH name/symbol, RestakeManager.paused()
    // false and renzoOracle() returning a live oracle address.
    expect(renzoDef.contracts.restakeManager.addresses["1"]).toBe(
      "0x74a09653A083691711cF8215a6ab074BB4e99ef5"
    );
    expect(renzoDef.contracts.ezeth.addresses["1"]).toBe(
      "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110"
    );
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(renzoDef);
    const retrieved = getProtocol("renzo");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("renzo");
    expect(retrieved?.name).toBe("Renzo");
  });

  // The icon has been replaced three times on this branch and drifted twice:
  // once to a 200x201 crop, once to an unrelated token image. The plugin picker
  // renders it beside the other liquid-staking marks, so pin the declared path
  // and the dimensions rather than trusting the file.
  it("ships the declared icon as a 256x256 PNG", () => {
    expect(renzoDef.icon).toBe("/protocols/renzo.png");
    const iconPath = join(process.cwd(), "public", "protocols", "renzo.png");
    expect(readPngSize(iconPath)).toEqual({ width: 256, height: 256 });
  });
});

/**
 * The advertised output model and the runtime result come from two different
 * names. `deriveOutput` builds the model from the registry override, while
 * `structureAbiOutputs` keys the result off the raw ABI output name. An ABI
 * output named "" therefore returns a bare scalar while the action still
 * advertises a named field, and every assertion on `action.outputs[].name`
 * passes either way. These walk the real ABI through the runtime structuring
 * and the coverage oracle instead, so the template path a workflow reads is
 * the thing under test.
 */
describe("Renzo read outputs resolve at runtime", () => {
  it("every advertised output name is a key in the structured result", () => {
    for (const action of renzoDef.actions.filter((a) => a.type === "read")) {
      const result = structuredResult(action);
      expect(
        typeof result,
        `read action "${action.slug}" structured to a bare scalar (${JSON.stringify(result)}), so no named template path exists`
      ).toBe("object");
      for (const output of action.outputs ?? []) {
        expect(
          Object.keys(result as Record<string, unknown>),
          `read action "${action.slug}" advertises output "${output.name}" that the structured result does not carry`
        ).toContain(output.name);
      }
    }
  });

  it("the pause gate is readable as result.paused", () => {
    expect(structuredResult(findAction("paused"))).toEqual({ paused: false });
  });

  it("every declared expectation resolves against the structured result", () => {
    const chain = renzoDef.testData?.["1"];
    expect(chain).toBeDefined();
    const expectations = Object.entries(chain?.expectations ?? {});
    expect(expectations.length).toBeGreaterThan(0);

    for (const [slug, checks] of expectations) {
      const output = {
        success: true,
        result: structuredResult(findAction(slug)),
      };
      for (const check of checks) {
        expect(
          checkOutputExpectation(output, check),
          `expectation on "${slug}" (${JSON.stringify(check)}) does not resolve`
        ).toBeNull();
      }
    }
  });

  it("every write expectation resolves against the read it names", () => {
    const chain = renzoDef.testData?.["1"];
    const writeExpectations = Object.entries(chain?.writeExpectations ?? {});
    expect(writeExpectations.length).toBeGreaterThan(0);

    for (const [slug, checks] of writeExpectations) {
      expect(findAction(slug).type).toBe("write");
      for (const check of checks) {
        const output = {
          success: true,
          result: structuredResult(findAction(check.read)),
        };
        expect(
          checkOutputExpectation(output, check.expect),
          `write expectation on "${slug}" reading "${check.read}" (${JSON.stringify(check.expect)}) does not resolve`
        ).toBeNull();
      }
    }
  });
});
