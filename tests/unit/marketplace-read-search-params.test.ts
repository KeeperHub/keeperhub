import { describe, expect, it } from "vitest";
import {
  MAX_QUERY_LENGTH,
  readOwnerParam,
  readQueryParam,
} from "@/lib/marketplace/read-search-params";

describe("readOwnerParam", () => {
  it("returns null for non-string values (missing, array, undefined)", () => {
    expect(readOwnerParam(undefined)).toBeNull();
    expect(readOwnerParam(["KeeperHub", "KeeperHub Demo"])).toBeNull();
  });

  it("returns null for empty / whitespace-only strings", () => {
    expect(readOwnerParam("")).toBeNull();
    expect(readOwnerParam("   ")).toBeNull();
    expect(readOwnerParam("\t \n")).toBeNull();
  });

  it("trims surrounding whitespace and returns the literal value", () => {
    expect(readOwnerParam("  KeeperHub  ")).toBe("KeeperHub");
    expect(readOwnerParam("Shelly's Organization")).toBe(
      "Shelly's Organization"
    );
  });

  it("preserves case (filter applies case-insensitive equality at SQL layer)", () => {
    expect(readOwnerParam("KeeperHub")).toBe("KeeperHub");
    expect(readOwnerParam("keeperhub")).toBe("keeperhub");
    expect(readOwnerParam("KEEPERHUB")).toBe("KEEPERHUB");
  });

  it("caps overly long values at MAX_QUERY_LENGTH to prevent cache-key pollution", () => {
    const long = "x".repeat(MAX_QUERY_LENGTH * 3);
    const result = readOwnerParam(long);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(MAX_QUERY_LENGTH);
  });

  it("does not collapse a non-empty owner that contains LIKE metacharacters (treated as literal at SQL layer)", () => {
    // The SQL layer uses `lower(name) = lower(value)` for owner — no LIKE
    // wildcards. So `%` and `_` should pass through verbatim.
    expect(readOwnerParam("100% Org")).toBe("100% Org");
    expect(readOwnerParam("ACME_Co")).toBe("ACME_Co");
  });
});

describe("readQueryParam", () => {
  it("returns empty string for non-string values", () => {
    expect(readQueryParam(undefined)).toBe("");
    expect(readQueryParam(["a", "b"])).toBe("");
  });

  it("trims and length-caps", () => {
    expect(readQueryParam("  hello  ")).toBe("hello");
    const long = "y".repeat(MAX_QUERY_LENGTH + 50);
    expect(readQueryParam(long)).toHaveLength(MAX_QUERY_LENGTH);
  });
});
