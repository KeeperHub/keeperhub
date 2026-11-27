import { describe, expect, it } from "vitest";
import { validateArgsForAbi } from "@/lib/abi/validate-args";

describe("validateArgsForAbi", () => {
  it("accepts empty args when ABI has no inputs", () => {
    expect(validateArgsForAbi([], { inputs: [] })).toEqual({ ok: true });
  });

  it("rejects empty string for uint256", () => {
    const result = validateArgsForAbi([""], {
      inputs: [{ name: "amount", type: "uint256" }],
    });
    expect(result).toEqual({
      ok: false,
      error: "amount: uint256 cannot be empty",
    });
  });

  it("rejects empty string for address", () => {
    const result = validateArgsForAbi([""], {
      inputs: [{ name: "recipient", type: "address" }],
    });
    expect(result).toEqual({
      ok: false,
      error: "recipient: address cannot be empty",
    });
  });

  it("rejects empty string for bool", () => {
    const result = validateArgsForAbi([""], {
      inputs: [{ name: "flag", type: "bool" }],
    });
    expect(result).toEqual({
      ok: false,
      error: "flag: bool cannot be empty",
    });
  });

  it("allows empty string for string type", () => {
    const result = validateArgsForAbi([""], {
      inputs: [{ name: "note", type: "string" }],
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects empty string for bytes with 0x hint", () => {
    const result = validateArgsForAbi([""], {
      inputs: [{ name: "data", type: "bytes" }],
    });
    expect(result).toEqual({
      ok: false,
      error: 'data: bytes cannot be empty (use "0x" for empty bytes)',
    });
  });

  it("rejects empty string for bytes32 with 0x hint", () => {
    const result = validateArgsForAbi([""], {
      inputs: [{ name: "hash", type: "bytes32" }],
    });
    expect(result).toEqual({
      ok: false,
      error: 'hash: bytes32 cannot be empty (use "0x" for empty bytes)',
    });
  });

  it('accepts "0x" for empty bytes', () => {
    const result = validateArgsForAbi(["0x"], {
      inputs: [{ name: "data", type: "bytes" }],
    });
    expect(result).toEqual({ ok: true });
  });

  it("allows template variable in uint256 slot", () => {
    const result = validateArgsForAbi(["{{Node1.value}}"], {
      inputs: [{ name: "amount", type: "uint256" }],
    });
    expect(result).toEqual({ ok: true });
  });

  it("allows template variable inside a tuple field", () => {
    const result = validateArgsForAbi(
      [{ target: "{{Node1.addr}}", value: "100" }],
      {
        inputs: [
          {
            name: "call",
            type: "tuple",
            components: [
              { name: "target", type: "address" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      }
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects tuple with empty numeric field and reports path", () => {
    const result = validateArgsForAbi([{ target: "0xabc", value: "" }], {
      inputs: [
        {
          name: "call",
          type: "tuple",
          components: [
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
          ],
        },
      ],
    });
    expect(result).toEqual({
      ok: false,
      error: "call.value: uint256 cannot be empty",
    });
  });

  it("rejects tuple array element with empty bytes field and reports indexed path", () => {
    const result = validateArgsForAbi(
      [
        [
          { target: "0xabc", allowFailure: true, callData: "0x01" },
          { target: "0xdef", allowFailure: false, callData: "" },
        ],
      ],
      {
        inputs: [
          {
            name: "calls",
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "allowFailure", type: "bool" },
              { name: "callData", type: "bytes" },
            ],
          },
        ],
      }
    );
    expect(result).toEqual({
      ok: false,
      error:
        'calls[1].callData: bytes cannot be empty (use "0x" for empty bytes)',
    });
  });

  it("rejects tuple array element with empty address and reports indexed path", () => {
    const result = validateArgsForAbi(
      [
        [
          { target: "0xabc", value: "1" },
          { target: "", value: "2" },
        ],
      ],
      {
        inputs: [
          {
            name: "calls",
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      }
    );
    expect(result).toEqual({
      ok: false,
      error: "calls[1].target: address cannot be empty",
    });
  });

  it("rejects nested tuple with empty leaf and reports dotted path", () => {
    const result = validateArgsForAbi([{ outer: { inner: "" } }], {
      inputs: [
        {
          name: "wrapper",
          type: "tuple",
          components: [
            {
              name: "outer",
              type: "tuple",
              components: [{ name: "inner", type: "uint256" }],
            },
          ],
        },
      ],
    });
    expect(result).toEqual({
      ok: false,
      error: "wrapper.outer.inner: uint256 cannot be empty",
    });
  });

  it("rejects primitive array with empty element", () => {
    const result = validateArgsForAbi([["0xabc", ""]], {
      inputs: [{ name: "recipients", type: "address[]" }],
    });
    expect(result).toEqual({
      ok: false,
      error: "recipients[1]: address cannot be empty",
    });
  });

  it("allows empty primitive array", () => {
    const result = validateArgsForAbi([[]], {
      inputs: [{ name: "recipients", type: "address[]" }],
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts fully-valid flat args", () => {
    const result = validateArgsForAbi(["0xabc", "1000", true], {
      inputs: [
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "flag", type: "bool" },
      ],
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects tuple that is missing a declared component", () => {
    const result = validateArgsForAbi([{ target: "0xabc" }], {
      inputs: [
        {
          name: "call",
          type: "tuple",
          components: [
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
          ],
        },
      ],
    });
    expect(result).toEqual({
      ok: false,
      error: "call.value: uint256 is missing",
    });
  });

  it("rejects non-object passed where tuple expected", () => {
    const result = validateArgsForAbi(["not-an-object"], {
      inputs: [
        {
          name: "call",
          type: "tuple",
          components: [{ name: "target", type: "address" }],
        },
      ],
    });
    expect(result).toEqual({
      ok: false,
      error: "call: expected object for tuple",
    });
  });

  it("uses argN label when input name is empty", () => {
    const result = validateArgsForAbi([""], {
      inputs: [{ name: "", type: "uint256" }],
    });
    expect(result).toEqual({
      ok: false,
      error: "arg0: uint256 cannot be empty",
    });
  });
});

describe("validateArgsForAbi options", () => {
  const flagFn = { inputs: [{ name: "on", type: "bool" }] };

  it("treats a {{...}} string as plain text when values are resolved", () => {
    expect(validateArgsForAbi(["{{@a:A.x}}"], flagFn)).toEqual({ ok: true });
    expect(
      validateArgsForAbi(["{{@a:A.x}}"], flagFn, {
        resolved: true,
        checkLeaf: (value, type, path) =>
          type === "bool" && typeof value !== "boolean"
            ? `${path} must be true or false`
            : undefined,
      })
    ).toEqual({ ok: false, error: "on must be true or false" });
  });

  it("runs checkLeaf on every present leaf, inside arrays and tuples", () => {
    const seen: string[] = [];
    const result = validateArgsForAbi(
      [["1", "2"], { a: "3" }],
      {
        inputs: [
          { name: "xs", type: "uint256[2]" },
          {
            name: "t",
            type: "tuple",
            components: [{ name: "a", type: "uint256" }],
          },
        ],
      },
      {
        fixedArrays: true,
        checkLeaf: (_value, type, path) => {
          seen.push(`${path}:${type}`);
          return undefined;
        },
      }
    );
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(["xs[0]:uint256", "xs[1]:uint256", "t.a:uint256"]);
  });

  it("checks the items and length of a fixed-size array when asked", () => {
    const fn = { inputs: [{ name: "xs", type: "uint256[2]" }] };
    const options = { fixedArrays: true };
    expect(validateArgsForAbi([["1", ""]], fn, options)).toEqual({
      ok: false,
      error: "xs[1]: uint256 cannot be empty",
    });
    expect(validateArgsForAbi([["1"]], fn, options)).toEqual({
      ok: false,
      error: "xs: uint256[2] takes 2 items, got 1",
    });
  });

  it("leaves a fixed-size array to the encoder by default", () => {
    // Positional tuples in a tuple[2] encode fine, so existing callers keep them.
    expect(
      validateArgsForAbi(
        [
          [
            ["1", "0x1"],
            ["2", "0x2"],
          ],
        ],
        {
          inputs: [
            {
              name: "ps",
              type: "tuple[2]",
              components: [
                { name: "a", type: "uint256" },
                { name: "b", type: "address" },
              ],
            },
          ],
        }
      )
    ).toEqual({ ok: true });
  });
});
