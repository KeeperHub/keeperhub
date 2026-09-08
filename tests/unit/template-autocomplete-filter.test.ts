import { describe, expect, it } from "vitest";
import {
  type AutocompleteOption,
  buildHaystack,
  filterOptionsByQuery,
  indexOption,
} from "@/lib/workflow/editor/template-autocomplete-filter";

function opt(partial: Partial<AutocompleteOption>): AutocompleteOption {
  return {
    type: "field",
    nodeId: "node-1",
    nodeName: "Manual",
    field: "data.triggered",
    description: undefined,
    template: "{{@node-1:Manual.data.triggered}}",
    ...partial,
  };
}

describe("buildHaystack", () => {
  it("joins node name, field, and description lowercased", () => {
    const haystack = buildHaystack(
      opt({
        nodeName: "FetchUser",
        field: "data.id",
        description: "User identifier",
      })
    );
    expect(haystack).toBe("fetchuser data.id user identifier");
  });

  it("renders missing field/description as empty without undefined", () => {
    const haystack = buildHaystack(
      opt({ nodeName: "Manual", field: undefined, description: undefined })
    );
    expect(haystack).toBe("manual  ");
    expect(haystack).not.toContain("undefined");
  });
});

describe("filterOptionsByQuery", () => {
  const options = [
    indexOption(
      opt({ nodeId: "a", nodeName: "Manual", field: "data.triggered" })
    ),
    indexOption(
      opt({ nodeId: "b", nodeName: "Manual", field: "data.triggeredAt" })
    ),
    indexOption(opt({ nodeId: "c", nodeName: "FetchUser", field: "data.id" })),
    indexOption(
      opt({
        nodeId: "d",
        nodeName: "FetchUser",
        field: "data.address.zipcode",
      })
    ),
    indexOption(
      opt({
        nodeId: "e",
        nodeName: "__system",
        field: "unixTimestamp",
        description: "Current unix timestamp in seconds",
      })
    ),
  ];

  it("returns every option when query is empty", () => {
    expect(filterOptionsByQuery(options, "")).toHaveLength(options.length);
  });

  it("returns every option when query is only whitespace", () => {
    expect(filterOptionsByQuery(options, "   ")).toHaveLength(options.length);
  });

  it("matches as a contiguous substring, not a subsequence", () => {
    // Regression for KEEP-320: "data.id" was matching "data.triggered" because
    // the characters d-a-t-a-.-i-d all appear in order inside the string.
    const result = filterOptionsByQuery(options, "data.id");
    expect(result.map((o) => o.nodeId)).toEqual(["c"]);
  });

  it("is case-insensitive", () => {
    const result = filterOptionsByQuery(options, "DATA.TRIGGEREDat");
    expect(result.map((o) => o.nodeId)).toEqual(["b"]);
  });

  it("matches substring of lowercased input against mixed-case haystack", () => {
    // "MG" inside "amG" example the user gave
    const result = filterOptionsByQuery(
      [indexOption(opt({ nodeId: "x", nodeName: "amGadmin" }))],
      "MG"
    );
    expect(result).toHaveLength(1);
  });

  it("matches against description text", () => {
    const result = filterOptionsByQuery(options, "timestamp");
    expect(result.map((o) => o.nodeId)).toEqual(["e"]);
  });

  it("requires every whitespace-separated token to match", () => {
    const result = filterOptionsByQuery(options, "fetchuser zip");
    expect(result.map((o) => o.nodeId)).toEqual(["d"]);
  });

  it("returns no results when one token has no substring match", () => {
    const result = filterOptionsByQuery(options, "fetchuser nomatch");
    expect(result).toHaveLength(0);
  });

  it("tokens can match across different parts of the haystack", () => {
    // "manual" matches nodeName, "triggeredat" matches field; both in the
    // same haystack string.
    const result = filterOptionsByQuery(options, "manual triggeredat");
    expect(result.map((o) => o.nodeId)).toEqual(["b"]);
  });
});
