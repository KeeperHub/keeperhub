import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";
import {
  isRawCalldataRequest,
  resolveRawCalldata,
  selectorOf,
} from "@/app/api/execute/_lib/raw-calldata";
import { validateContractCallInput } from "@/app/api/execute/_lib/validate";

const SPENDER = "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca";
const OWNER = "0x0BDf000000000000000000000000000000000001";

const ERC20_ABI = JSON.stringify([
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
]);

const iface = new ethers.Interface(JSON.parse(ERC20_ABI));

describe("isRawCalldataRequest", () => {
  it("is keyed on the data key being present, as the schema is", () => {
    expect(isRawCalldataRequest({ data: "0x095ea7b3" })).toBe(true);
    expect(isRawCalldataRequest({ functionName: "approve" })).toBe(false);
  });
});

describe("selectorOf", () => {
  it("returns the lowercase 4-byte selector", () => {
    expect(selectorOf(`0x095EA7B3${"00".repeat(64)}`)).toBe("0x095ea7b3");
  });

  it("rejects non-hex and too-short data", () => {
    expect(selectorOf("095ea7b3")).toEqual({
      error: expect.stringContaining("0x-prefixed"),
    });
    expect(selectorOf("0x")).toEqual({
      error: expect.stringContaining("4-byte"),
    });
    expect(selectorOf("0x095ea7")).toEqual({
      error: expect.stringContaining("4-byte"),
    });
  });
});

describe("resolveRawCalldata", () => {
  it("decodes an ERC-20 approve into the canonical key and typed args", () => {
    const data = iface.encodeFunctionData("approve", [
      SPENDER,
      BigInt("5000000"),
    ]);

    const result = resolveRawCalldata(data, ERC20_ABI);

    expect(result).toEqual({
      functionName: "approve(address,uint256)",
      functionArgs: JSON.stringify([SPENDER, "5000000"]),
      selector: "0x095ea7b3",
    });
  });

  it("renders arrays, bytes, bools and name-keyed tuples the way functionArgs accepts them", () => {
    const abi = JSON.stringify([
      {
        type: "function",
        name: "supply",
        stateMutability: "nonpayable",
        inputs: [
          {
            name: "marketParams",
            type: "tuple",
            components: [
              { name: "loanToken", type: "address" },
              { name: "lltv", type: "uint256" },
            ],
          },
          { name: "amounts", type: "uint256[]" },
          { name: "data", type: "bytes" },
          { name: "flag", type: "bool" },
        ],
        outputs: [],
      },
    ]);
    const supplyIface = new ethers.Interface(JSON.parse(abi));
    const data = supplyIface.encodeFunctionData("supply", [
      [OWNER, BigInt("860000000000000000")],
      [BigInt("1"), BigInt("2")],
      "0x01ff",
      true,
    ]);

    const result = resolveRawCalldata(data, abi);

    expect(result).toMatchObject({
      functionName: "supply((address,uint256),uint256[],bytes,bool)",
    });
    expect(
      JSON.parse((result as { functionArgs: string }).functionArgs)
    ).toEqual([
      { loanToken: OWNER, lltv: "860000000000000000" },
      ["1", "2"],
      "0x01ff",
      true,
    ]);
  });

  it("refuses a selector the ABI does not contain instead of guessing", () => {
    const data = `0xdeadbeef${"00".repeat(64)}`;

    const result = resolveRawCalldata(data, ERC20_ABI);

    expect(result).toEqual({
      error: expect.stringContaining("0xdeadbeef is not in the ABI"),
    });
  });

  it("reports calldata that does not decode against the matched fragment", () => {
    const truncated = iface
      .encodeFunctionData("approve", [SPENDER, BigInt("1")])
      .slice(0, 20);

    const result = resolveRawCalldata(truncated, ERC20_ABI);

    expect(result).toEqual({
      error: expect.stringContaining("does not decode"),
    });
  });

  it("rejects an invalid ABI", () => {
    expect(
      resolveRawCalldata(`0x095ea7b3${"00".repeat(64)}`, "{not json")
    ).toEqual({
      error: "Invalid ABI JSON",
    });
  });
});

describe("re-encoding", () => {
  const approveData = iface.encodeFunctionData("approve", [
    SPENDER,
    BigInt("1000000"),
  ]);

  it("refuses trailing bytes past the arguments", () => {
    const result = resolveRawCalldata(
      `${approveData}${OWNER.slice(2)}`,
      ERC20_ABI
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("canonical encoding");
  });

  it("refuses non-canonical padding of a decoded argument", () => {
    // Encoded as 2, decodes as true, re-encodes as 1.
    const boolAbi = JSON.stringify([
      {
        type: "function",
        name: "setFlag",
        stateMutability: "nonpayable",
        inputs: [{ name: "on", type: "bool" }],
        outputs: [],
      },
    ]);
    const boolIface = new ethers.Interface(JSON.parse(boolAbi));
    const fragment = boolIface.getFunction("setFlag");
    if (fragment === null) {
      throw new Error("setFlag missing from the test ABI");
    }
    const selector = fragment.selector;
    const result = resolveRawCalldata(
      `${selector}${"00".repeat(31)}02`,
      boolAbi
    );
    expect(result).toHaveProperty("error");
  });

  it("accepts calldata that re-encodes byte for byte", () => {
    expect(resolveRawCalldata(approveData, ERC20_ABI)).toMatchObject({
      functionName: "approve(address,uint256)",
    });
  });
});

describe("the decoder never reaches the network", () => {
  it("makes no request when the ABI does not contain the selector", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const unknownSelector = `0xdeadbeef${"00".repeat(32)}`;

    const result = resolveRawCalldata(unknownSelector, ERC20_ABI);

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("not in the ABI");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("contractCallInputSchema with raw calldata", () => {
  const base = {
    chainId: 8453,
    contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    abi: ERC20_ABI,
  };

  it("requires functionName only when data is absent", () => {
    expect(validateContractCallInput({ ...base }).valid).toBe(false);
    expect(
      validateContractCallInput({
        ...base,
        data: iface.encodeFunctionData("approve", [SPENDER, BigInt("1")]),
      }).valid
    ).toBe(true);
  });

  it("keeps the functionName/abiFunction conflict guard intact", () => {
    const result = validateContractCallInput({
      ...base,
      functionName: "transfer",
      abiFunction: "transferFrom",
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error.field).toBe("abiFunction");
  });

  it("rejects data that is not whole bytes of 0x-prefixed hex", () => {
    for (const data of [
      "095ea7b3",
      "0x095ea7b",
      "0xzz95ea7b3",
      "0x095ea7",
      7,
    ]) {
      const result = validateContractCallInput({ ...base, data });
      expect(result.valid).toBe(false);
      expect(result.valid === false && result.error.field).toBe("data");
    }
  });

  it("rejects data next to functionName as a conflict, before shape", () => {
    for (const key of ["functionName", "abiFunction"]) {
      const result = validateContractCallInput({
        ...base,
        data: "0xnothex",
        [key]: "approve",
      });
      expect(result.valid).toBe(false);
      if (result.valid) {
        throw new Error("expected a conflict");
      }
      expect(result.error.field).toBe("data");
      expect(result.error.error).toBe("Conflicting field values");
      expect(result.error.details).toContain(key);
    }
  });

  it("treats an empty function key as present, like functionNameConflict does", () => {
    const result = validateContractCallInput({
      ...base,
      data: iface.encodeFunctionData("approve", [SPENDER, BigInt("1")]),
      abiFunction: "",
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error.field).toBe("data");
  });
});
