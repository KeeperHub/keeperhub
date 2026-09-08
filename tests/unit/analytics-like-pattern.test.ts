import { describe, expect, it } from "vitest";
import { likePattern } from "@/lib/analytics/like-pattern";

describe("likePattern", () => {
  it("wraps a plain term in wildcards", () => {
    expect(likePattern("swap")).toBe("%swap%");
  });

  it("escapes an underscore so it matches a literal underscore", () => {
    // Unescaped, `my_workflow` also matched `myXworkflow`.
    expect(likePattern("my_workflow")).toBe("%my\\_workflow%");
  });

  it("escapes a percent so it does not match every row", () => {
    expect(likePattern("100%")).toBe("%100\\%%");
  });

  it("escapes a backslash before it can escape something else", () => {
    expect(likePattern("a\\b")).toBe("%a\\\\b%");
  });

  it("leaves a term with no metacharacters untouched", () => {
    expect(likePattern("wrun_01M1")).toBe("%wrun\\_01M1%");
  });
});
