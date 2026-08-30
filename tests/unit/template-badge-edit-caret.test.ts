import { describe, expect, it } from "vitest";
import { caretOffsetForBadgeEdit } from "@/components/ui/template-badge-editor";

describe("caretOffsetForBadgeEdit", () => {
  it("parks the caret just inside the closing braces", () => {
    const raw = "{{@abc123:Manual.data}}";
    expect(caretOffsetForBadgeEdit(raw)).toBe(raw.length - 2);
    expect(raw.slice(caretOffsetForBadgeEdit(raw))).toBe("}}");
  });

  it("keeps the whole path to the left of the caret", () => {
    const raw = "{{@abc123:Manual.data.timestamp}}";
    expect(raw.slice(0, caretOffsetForBadgeEdit(raw))).toBe(
      "{{@abc123:Manual.data.timestamp"
    );
  });

  it("falls back to the end for a token that is not brace-closed", () => {
    expect(caretOffsetForBadgeEdit("{{@abc:Manual.data")).toBe(18);
  });

  it("never returns a negative offset", () => {
    expect(caretOffsetForBadgeEdit("")).toBe(0);
  });
});
