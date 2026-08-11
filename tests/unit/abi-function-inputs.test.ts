import { describe, expect, it } from "vitest";

import {
  isValidAbiInput,
  resolveFunctionInputs,
} from "@/lib/abi/function-inputs";

const TRANSFER_ABI = JSON.stringify([
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
]);

const MISSING_TYPE_ABI = JSON.stringify([
  {
    name: "transfer",
    type: "function",
    inputs: [{ name: "to", type: "address" }, { name: "amount" }],
  },
]);

const MISSING_TUPLE_COMPONENT_TYPE_ABI = JSON.stringify([
  {
    name: "execute",
    type: "function",
    inputs: [
      {
        name: "call",
        type: "tuple",
        components: [{ name: "target", type: "address" }, { name: "data" }],
      },
    ],
  },
]);

const NO_PARAMS_ABI = JSON.stringify([
  { name: "totalSupply", type: "function", inputs: [] },
]);

describe("resolveFunctionInputs", () => {
  it("returns the inputs of a well-formed function", () => {
    expect(resolveFunctionInputs(TRANSFER_ABI, "transfer")).toEqual({
      inputs: [
        { name: "to", type: "address", components: undefined },
        { name: "amount", type: "uint256", components: undefined },
      ],
      malformed: false,
    });
  });

  it("reports malformed and withholds every input when one has no type", () => {
    const result = resolveFunctionInputs(MISSING_TYPE_ABI, "transfer");

    expect(result.malformed).toBe(true);
    expect(result.inputs).toEqual([]);
  });

  it("reports malformed when a tuple component has no type", () => {
    const result = resolveFunctionInputs(
      MISSING_TUPLE_COMPONENT_TYPE_ABI,
      "execute"
    );

    expect(result.malformed).toBe(true);
    expect(result.inputs).toEqual([]);
  });

  it("reports malformed for unparseable and non-array ABIs", () => {
    expect(resolveFunctionInputs("not json", "transfer").malformed).toBe(true);
    expect(
      resolveFunctionInputs('{"not":"an array"}', "transfer").malformed
    ).toBe(true);
  });

  it("is not malformed when nothing has been selected yet", () => {
    expect(resolveFunctionInputs("", "transfer")).toEqual({
      inputs: [],
      malformed: false,
    });
    expect(resolveFunctionInputs(TRANSFER_ABI, "")).toEqual({
      inputs: [],
      malformed: false,
    });
  });

  it("is not malformed when the function is absent or takes no parameters", () => {
    expect(resolveFunctionInputs(TRANSFER_ABI, "missing")).toEqual({
      inputs: [],
      malformed: false,
    });
    expect(resolveFunctionInputs(NO_PARAMS_ABI, "totalSupply")).toEqual({
      inputs: [],
      malformed: false,
    });
  });

  it("defaults unnamed parameters to 'unnamed'", () => {
    const abi = JSON.stringify([
      {
        name: "test",
        type: "function",
        inputs: [{ name: "", type: "uint256" }],
      },
    ]);

    expect(resolveFunctionInputs(abi, "test").inputs).toEqual([
      { name: "unnamed", type: "uint256", components: undefined },
    ]);
  });
});

describe("isValidAbiInput", () => {
  it("accepts inputs with a non-empty string type", () => {
    expect(isValidAbiInput({ name: "to", type: "address" })).toBe(true);
  });

  it("rejects missing, empty and non-string types", () => {
    expect(isValidAbiInput({ name: "to" })).toBe(false);
    expect(isValidAbiInput({ name: "to", type: "" })).toBe(false);
    expect(isValidAbiInput({ name: "to", type: 1 })).toBe(false);
    expect(isValidAbiInput(null)).toBe(false);
    expect(isValidAbiInput("address")).toBe(false);
  });

  it("recurses into tuple components", () => {
    expect(
      isValidAbiInput({
        type: "tuple",
        components: [{ type: "address" }],
      })
    ).toBe(true);
    expect(
      isValidAbiInput({
        type: "tuple",
        components: [{ name: "data" }],
      })
    ).toBe(false);
    expect(isValidAbiInput({ type: "tuple", components: {} })).toBe(false);
  });
});
