/**
 * The single parse every protocol-array consumer reads a stored value
 * through. Array inputs were plain text fields before they had a structured
 * editor, so a saved config can hold a bare scalar or a comma-separated list
 * where an array is now expected, and the executor resolves a whole-field
 * reference to the array itself.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isSolidityArrayType,
  isWholeFieldTemplate,
  normalizeProtocolArrayValue,
  serializeProtocolArrayValue,
  solidityArrayItemType,
} from "@/lib/protocol-array-value";
import { processTemplates } from "@/lib/workflow/executor/executor.workflow";

describe("isSolidityArrayType", () => {
  it.each([
    ["uint256[]", true],
    ["address[2]", true],
    ["tuple[]", true],
    ["uint256", false],
    ["address", false],
    [undefined, false],
  ])("reads %s as %s", (solidityType, expected) => {
    expect(isSolidityArrayType(solidityType)).toBe(expected);
  });
});

describe("solidityArrayItemType", () => {
  it.each([
    ["uint256[]", "uint256"],
    ["address[2]", "address"],
    ["tuple[]", "tuple"],
  ])("strips the suffix of %s", (solidityType, expected) => {
    expect(solidityArrayItemType(solidityType)).toBe(expected);
  });
});

describe("normalizeProtocolArrayValue", () => {
  it("leaves a non-array input untouched", () => {
    expect(normalizeProtocolArrayValue("0xabc", "address")).toBe("0xabc");
    expect(normalizeProtocolArrayValue("135184", "uint256")).toBe("135184");
  });

  it("parses a JSON array string", () => {
    expect(
      normalizeProtocolArrayValue('["135184","135185"]', "uint256[]")
    ).toEqual(["135184", "135185"]);
  });

  it("takes an array as it is", () => {
    const value = ["0xpool1"];
    expect(normalizeProtocolArrayValue(value, "address[]")).toBe(value);
  });

  it("reads a legacy single scalar as a one-item array", () => {
    expect(
      normalizeProtocolArrayValue(
        "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        "address[]"
      )
    ).toEqual(["0x1F98431c8aD98523631AE4a59f267346ea31F984"]);
    expect(normalizeProtocolArrayValue("135184", "uint256[]")).toEqual([
      "135184",
    ]);
  });

  it("keeps a large legacy integer as its exact text", () => {
    expect(
      normalizeProtocolArrayValue("1000000000000000000000", "uint256[]")
    ).toEqual(["1000000000000000000000"]);
  });

  it("splits a legacy comma-separated list of comma-safe scalars", () => {
    expect(
      normalizeProtocolArrayValue("0xpool1, 0xpool2", "address[]")
    ).toEqual(["0xpool1", "0xpool2"]);
  });

  it("does not split commas that are string data", () => {
    expect(normalizeProtocolArrayValue("Hello, world", "string[]")).toEqual([
      "Hello, world",
    ]);
  });

  it("keeps a whole-field reference bare so it can resolve to an array", () => {
    expect(
      normalizeProtocolArrayValue(
        "{{@n1:Get Withdrawal Requests.requestsIds}}",
        "uint256[]"
      )
    ).toBe("{{@n1:Get Withdrawal Requests.requestsIds}}");
  });

  it("preserves an uninterpretable value as a single item", () => {
    expect(normalizeProtocolArrayValue('{"amount":"1"}', "uint256[]")).toEqual([
      '{"amount":"1"}',
    ]);
    expect(normalizeProtocolArrayValue("not json", "uint256[]")).toEqual([
      "not json",
    ]);
  });

  it("keeps a parsed object for a tuple array", () => {
    expect(normalizeProtocolArrayValue('{"amount":"1"}', "tuple[]")).toEqual([
      { amount: "1" },
    ]);
  });

  it("wraps a legacy non-string scalar", () => {
    expect(normalizeProtocolArrayValue(135_184, "uint256[]")).toEqual([
      135_184,
    ]);
    expect(normalizeProtocolArrayValue(true, "bool[]")).toEqual([true]);
  });

  it("leaves blank and nullish values alone", () => {
    expect(normalizeProtocolArrayValue("", "uint256[]")).toBe("");
    expect(normalizeProtocolArrayValue(undefined, "uint256[]")).toBeUndefined();
    expect(normalizeProtocolArrayValue(null, "uint256[]")).toBeNull();
  });

  it("keeps an encoded empty array empty", () => {
    expect(normalizeProtocolArrayValue("[]", "uint256[]")).toEqual([]);
  });
});

describe("isWholeFieldTemplate", () => {
  it.each([
    ["{{@n1:Label.field}}", true],
    ["  {{@n1:Label.field}}  ", true],
    ["{{a}}, {{b}}", false],
    ["0x{{a}}", false],
    ["135184", false],
  ])("reads %s as %s", (value, expected) => {
    expect(isWholeFieldTemplate(value)).toBe(expected);
  });
});

describe("serializeProtocolArrayValue", () => {
  it("stores a lone whole-field reference bare", () => {
    expect(
      serializeProtocolArrayValue([
        "{{@n1:Get Withdrawal Requests.requestsIds}}",
      ])
    ).toBe("{{@n1:Get Withdrawal Requests.requestsIds}}");
  });

  it("round-trips a whole-field reference through the editor", () => {
    const stored = "{{@n1:Get Withdrawal Requests.requestsIds}}";
    const rows = normalizeProtocolArrayValue(stored, "uint256[]");
    expect(serializeProtocolArrayValue([rows])).toBe(stored);
  });

  it("stores everything else as a JSON array", () => {
    expect(serializeProtocolArrayValue(["135184", "135185"])).toBe(
      '["135184","135185"]'
    );
    expect(serializeProtocolArrayValue([])).toBe("[]");
    expect(serializeProtocolArrayValue(["{{a}}", "{{b}}"])).toBe(
      '["{{a}}","{{b}}"]'
    );
  });
});

/**
 * The composition the array actions exist for: one action's array output
 * feeds the next action's array input. The reference is stored bare, the
 * executor renders it to the JSON text of the resolved array, and the step
 * reads that back as an array.
 */
describe("whole-field reference through execution", () => {
  it("resolves to an array the step can encode", () => {
    const stored = serializeProtocolArrayValue([
      "{{@n1:Get Withdrawal Requests.requestsIds}}",
    ]);

    const rendered = processTemplates(
      { requestIds: stored },
      {
        n1: {
          label: "Get Withdrawal Requests",
          data: { requestsIds: ["135184", "135185"] },
        },
      }
    );

    expect(
      normalizeProtocolArrayValue(rendered.requestIds, "uint256[]")
    ).toEqual(["135184", "135185"]);
  });
});
