import { describe, expect, it } from "vitest";
import { hasUsableSelection } from "@/components/ui/template-badge-input";

describe("hasUsableSelection", () => {
  it("returns false for null", () => {
    expect(hasUsableSelection(null)).toBe(false);
  });

  it("returns false when rangeCount is 0", () => {
    const selection = { rangeCount: 0 } as unknown as Selection;
    expect(hasUsableSelection(selection)).toBe(false);
  });

  it("returns true when rangeCount is >= 1", () => {
    const selection = { rangeCount: 1 } as unknown as Selection;
    expect(hasUsableSelection(selection)).toBe(true);
  });
});
