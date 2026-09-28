import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { type AbiItem, findAbiFunction } from "@/lib/abi/utils";
import type { ProtocolAction } from "@/lib/protocol-registry";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import { classifyRevert } from "@/lib/web3/decode-revert-error";
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
 * 2026-09-17, with `deposit-paused` added on 2026-09-21 at block 26024442:
 * `paused()` returned 0x00..00, the risk-oracle middleware's `depositPaused()`
 * returned 0x00..00 and ezETH `totalSupply()` returned 0x8c0111289f2afea6b1c.
 * Held as a fixture, BigInt-serialized the way readContractCore records them,
 * so the checks below run in PR CI without an RPC. The balance is a stand-in;
 * only its shape matters.
 */
const DECODED_RETURNS: Record<string, unknown[]> = {
  paused: [false],
  "deposit-paused": [false],
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

  it("has three contracts (restakeManager, riskOracleMiddleware, ezeth)", () => {
    expect(Object.keys(renzoDef.contracts).sort()).toEqual([
      "ezeth",
      "restakeManager",
      "riskOracleMiddleware",
    ]);
    expect(renzoDef.contracts.restakeManager.label).toBe(
      "Renzo Restake Manager"
    );
    expect(renzoDef.contracts.riskOracleMiddleware.label).toBe(
      "Renzo Risk Oracle Middleware"
    );
    expect(renzoDef.contracts.ezeth.label).toBe("ezETH Token");
  });

  it("has 5 actions: 1 write and 4 reads", () => {
    expect(renzoDef.actions).toHaveLength(5);
    const reads = renzoDef.actions.filter((a) => a.type === "read");
    const writes = renzoDef.actions.filter((a) => a.type === "write");
    expect(reads).toHaveLength(4);
    expect(writes).toHaveLength(1);
  });

  it("exposes the expected action slugs", () => {
    const slugs = renzoDef.actions.map((a) => a.slug).sort();
    expect(slugs).toEqual(
      [
        "deposit-paused",
        "ez-balance-of",
        "ez-total-supply",
        "paused",
        "stake",
      ].sort()
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

  // The gate `depositETH()` carries is `paused || riskOracleMiddleware
  // .depositPaused()`, so the manager flag alone cannot answer "are deposits
  // accepted". Both halves have to be on the definition, on their own
  // contracts, and neither label may claim to be the whole gate.
  it("deposit-paused reads the middleware's bool on its own contract", () => {
    const gate = renzoDef.actions.find((a) => a.slug === "deposit-paused");
    expect(gate).toBeDefined();
    expect(gate?.type).toBe("read");
    expect(gate?.contract).toBe("riskOracleMiddleware");
    expect(gate?.function).toBe("depositPaused");
    expect(gate?.inputs).toHaveLength(0);
    expect(gate?.outputs).toHaveLength(1);
    expect(gate?.outputs?.[0].name).toBe("depositPaused");
    expect(gate?.outputs?.[0].type).toBe("bool");
  });

  it("neither pause label claims to be the whole deposit gate", () => {
    const labels = renzoDef.actions
      .filter((a) => a.slug === "paused" || a.slug === "deposit-paused")
      .map((a) => a.label);
    expect(labels).toHaveLength(2);
    expect(labels).not.toContain("Check Deposit Pause Status");
    expect(labels.sort()).toEqual([
      "Check Manager Pause Flag",
      "Check Risk Oracle Deposit Pause",
    ]);
  });

  // `deriveOutput` looks an output override up by the raw ABI output name and
  // falls back to `camelToTitle(rawName)` when the key does not match, so a
  // drifted key degrades to "Paused" / "Deposit Paused" without failing
  // anything. The two bool outputs carry no `decimals` to pin them the way the
  // ezETH reads are pinned, so pin the label text instead.
  it("both bool outputs keep their overridden labels", () => {
    expect(findAction("paused").outputs?.[0].label).toBe("Manager Paused");
    expect(findAction("deposit-paused").outputs?.[0].label).toBe(
      "Risk Oracle Deposits Paused"
    );
  });

  // Both halves must be readable by a workflow, so both must be enrolled in the
  // fork sweep and both must carry a chain expectation. A half that is declared
  // but never exercised is how the single-condition gate got this far.
  it("testData exercises both halves of the deposit gate", () => {
    const chain = renzoDef.testData?.["1"];
    expect(Object.keys(chain?.actions ?? {})).toContain("paused");
    expect(Object.keys(chain?.actions ?? {})).toContain("deposit-paused");
    expect(chain?.expectations?.paused).toEqual([
      { field: "paused", equals: "false" },
    ]);
    expect(chain?.expectations?.["deposit-paused"]).toEqual([
      { field: "depositPaused", equals: "false" },
    ]);
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

  // Definition-level lock, not an on-chain claim: it pins that no chain beyond
  // mainnet was added to any contract. Which of these chains are actually empty
  // is recorded in docs/plugins/renzo.md with the blocks it was read at.
  it("declares no chain other than mainnet for Sepolia, Holesky, Goerli, Base or Arbitrum", () => {
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
    // false and renzoOracle() returning a live oracle address. Re-read
    // 2026-09-21 at block 26024442, when RestakeManager.riskOracleMiddleware()
    // returned the middleware address below.
    expect(renzoDef.contracts.restakeManager.addresses["1"]).toBe(
      "0x74a09653A083691711cF8215a6ab074BB4e99ef5"
    );
    expect(renzoDef.contracts.riskOracleMiddleware.addresses["1"]).toBe(
      "0x08921F17A32110F8df44A3d5007F2acd09Cfae6d"
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

  it("the middleware gate is readable as result.depositPaused", () => {
    expect(structuredResult(findAction("deposit-paused"))).toEqual({
      depositPaused: false,
    });
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

/**
 * A failed stake reaches the user through `classifyRevert`, which tries the
 * TARGET contract's interface first, then the shared Roles and common-error
 * lists, then a bare string decode. Neither shared list holds a Renzo error, so
 * with no `error` fragments on the RestakeManager document every revert a
 * `depositETH()` can produce came back `{ kind: "unknown" }` and the user saw a
 * four-byte selector. These pin the naming against selectors computed from the
 * signatures, and `0x21607339` is the selector measured on mainnet for
 * `depositETH()` sent no value.
 */
describe("Renzo stake reverts are named, not raw selectors", () => {
  const restakeManagerInterface = new ethers.Interface(
    JSON.parse(renzoDef.contracts.restakeManager.abi as string)
  );

  /** What an ethers CALL_EXCEPTION carrying revert data looks like. */
  function revertWith(data: string) {
    return { code: "CALL_EXCEPTION", data };
  }

  /**
   * Every error the RestakeManager document declares: the manager's own
   * verified set, then the five that bubble up from `RenzoOracle` and
   * `OperatorDelegator`, each paired with the selector its signature hashes
   * to. `argTail` carries ABI-encoded arguments for the one fragment that
   * takes any, because a bare selector does not parse against it.
   */
  const DECLARED_ERRORS: {
    signature: string;
    selector: string;
    argTail?: string;
  }[] = [
    { signature: "AlreadyAdded()", selector: "0xf411c327" },
    { signature: "ContractPaused()", selector: "0xab35696f" },
    { signature: "InvalidTVL()", selector: "0x344f641a" },
    {
      signature: "InvalidTokenDecimals(uint8,uint8)",
      selector: "0xc251ac7c",
      argTail: ethers.AbiCoder.defaultAbiCoder()
        .encode(["uint8", "uint8"], [18, 6])
        .slice(2),
    },
    { signature: "InvalidZeroInput()", selector: "0x862a6067" },
    { signature: "MaxTokenTVLReached()", selector: "0x12e96886" },
    { signature: "NotDepositQueue()", selector: "0x14bc7046" },
    { signature: "NotDepositWithdrawPauser()", selector: "0xc2952d6b" },
    { signature: "NotFound()", selector: "0xc5723b51" },
    { signature: "NotRestakeManagerAdmin()", selector: "0x2ec79ab9" },
    // The missing `r` is the contract's own spelling. Correcting it hashes to
    // 0x021e91c1, which nothing ever raises.
    { signature: "OperatoDelegatorNotDelegated()", selector: "0xdca284ad" },
    { signature: "OverMaxBasisPoints()", selector: "0x6b5c4261" },
    { signature: "InvalidTokenAmount()", selector: "0x21607339" },
    { signature: "OracleNotFound()", selector: "0x2c283834" },
    { signature: "OraclePriceExpired()", selector: "0xeafdc186" },
    { signature: "InvalidOraclePrice()", selector: "0x1f8f95a0" },
    { signature: "CheckpointNotRecorded()", selector: "0x93c952a8" },
  ];

  it("each pinned selector is the keccak hash of its signature", () => {
    for (const { signature, selector } of DECLARED_ERRORS) {
      expect(ethers.id(signature).slice(0, 10), signature).toBe(selector);
    }
  });

  // A selector the document does not declare is indistinguishable from
  // 0xdeadbeef below: the user gets four bytes. Every error the document
  // declares therefore has to decode back to a name here.
  it("names every error the document declares", () => {
    for (const { signature, selector, argTail } of DECLARED_ERRORS) {
      expect(
        classifyRevert(
          revertWith(`${selector}${argTail ?? ""}`),
          restakeManagerInterface
        ),
        signature
      ).toEqual({
        kind: "contract-custom",
        name: signature.slice(0, signature.indexOf("(")),
      });
    }
  });

  it("still returns unknown for a selector the document does not declare", () => {
    expect(
      classifyRevert(revertWith("0xdeadbeef"), restakeManagerInterface)
    ).toEqual({ kind: "unknown" });
  });
});
