import { describe, expect, it } from "vitest";
import { stripTrailingSlashes } from "@/lib/utils/url";

/**
 * Pins the flavour chosen when eighteen copies of this regex were merged. The
 * non-greedy copies left one slash behind on a doubled suffix, which then
 * produced a doubled separator once the caller appended its path.
 */
describe("stripTrailingSlashes", () => {
  it("strips every trailing slash, not just the last one", () => {
    expect(stripTrailingSlashes("https://host//")).toBe("https://host");
    expect(stripTrailingSlashes("https://host///")).toBe("https://host");
  });

  it("strips a single trailing slash", () => {
    expect(stripTrailingSlashes("https://host/")).toBe("https://host");
  });

  it("leaves a URL without a trailing slash alone", () => {
    expect(stripTrailingSlashes("https://host")).toBe("https://host");
    expect(stripTrailingSlashes("https://host/path")).toBe("https://host/path");
  });

  it("does not touch slashes that are not at the end", () => {
    expect(stripTrailingSlashes("https://host//path")).toBe(
      "https://host//path"
    );
  });

  it("handles the empty string", () => {
    expect(stripTrailingSlashes("")).toBe("");
  });
});
