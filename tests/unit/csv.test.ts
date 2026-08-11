import { describe, expect, it } from "vitest";
import { toCsvCell } from "@/lib/security/csv";

describe("toCsvCell", () => {
  it("returns empty string for null/undefined", () => {
    expect(toCsvCell(null)).toBe("");
    expect(toCsvCell(undefined)).toBe("");
  });

  it("passes plain text through unchanged", () => {
    expect(toCsvCell("created an API key")).toBe("created an API key");
  });

  it("quotes and doubles embedded quotes/commas/newlines", () => {
    expect(toCsvCell("a,b")).toBe('"a,b"');
    expect(toCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(toCsvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("neutralizes formula-injection prefixes (=, +, -, @)", () => {
    expect(toCsvCell("=cmd()")).toBe("'=cmd()");
    expect(toCsvCell("+1+2")).toBe("'+1+2");
    expect(toCsvCell("-2+3")).toBe("'-2+3");
    expect(toCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("neutralizes a formula prefix AND quotes when both apply", () => {
    // Leading "=" is escaped with a quote, and the comma forces CSV quoting.
    expect(toCsvCell("=HYPERLINK(x),y")).toBe(`"'=HYPERLINK(x),y"`);
  });

  it("serializes non-string values as JSON", () => {
    expect(toCsvCell(42)).toBe("42");
    expect(toCsvCell([{ kind: "E" }])).toBe('"[{""kind"":""E""}]"');
  });
});
