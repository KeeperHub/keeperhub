import { describe, expect, it } from "vitest";

import { isReservedSlug, RESERVED_SLUGS } from "@/lib/workflow/reserved-slugs";

// HUB-11, HUB-15 — reserved-slug validator is shared between
// workflow.listedSlug and publicTags.slug validators. The 9 reserved entries
// MUST collide with reserved Next.js path segments under /hub/tags/[tag].
const EXPECTED_RESERVED = [
  "tags",
  "protocol",
  "marketplace",
  "auth",
  "api",
  "admin",
  "_next",
  "og",
  "well-known",
] as const;

describe("RESERVED_SLUGS tuple", () => {
  it("contains exactly 9 entries in the documented order", () => {
    expect(RESERVED_SLUGS).toEqual(EXPECTED_RESERVED);
    expect(RESERVED_SLUGS).toHaveLength(9);
  });

  it("contains every entry exactly once (no duplicates)", () => {
    const unique = new Set<string>(RESERVED_SLUGS);
    expect(unique.size).toBe(RESERVED_SLUGS.length);
  });

  it("every entry is non-empty and lowercase-canonical", () => {
    for (const slug of RESERVED_SLUGS) {
      expect(slug.length).toBeGreaterThan(0);
      expect(slug).toBe(slug.toLowerCase());
    }
  });
});

describe("isReservedSlug — exhaustive reserved coverage", () => {
  it("returns true for every entry in RESERVED_SLUGS", () => {
    for (const slug of RESERVED_SLUGS) {
      expect(isReservedSlug(slug)).toBe(true);
    }
  });

  it.each(EXPECTED_RESERVED)("returns true for reserved word: %s", (slug) => {
    expect(isReservedSlug(slug)).toBe(true);
  });

  it("returns true for uppercased variants of every reserved entry", () => {
    for (const slug of RESERVED_SLUGS) {
      expect(isReservedSlug(slug.toUpperCase())).toBe(true);
    }
  });

  it("returns true for mixed-case variants", () => {
    expect(isReservedSlug("TAGS")).toBe(true);
    expect(isReservedSlug("Marketplace")).toBe(true);
    expect(isReservedSlug("Auth")).toBe(true);
    expect(isReservedSlug("WELL-KNOWN")).toBe(true);
    expect(isReservedSlug("Well-Known")).toBe(true);
  });
});

describe("isReservedSlug — non-reserved acceptance", () => {
  it.each([
    "defi",
    "lending",
    "yield",
    "my-cool-workflow",
    "swap",
    "bridge",
    "nft",
    "dao",
    "liquidity",
    "governance",
  ])("returns false for valid slug: %s", (slug) => {
    expect(isReservedSlug(slug)).toBe(false);
  });

  it("returns false for the empty string", () => {
    expect(isReservedSlug("")).toBe(false);
  });

  it("returns false for whitespace-only input (no implicit trim)", () => {
    // The validator does NOT trim — callers slugify first; surfacing this
    // contract via test prevents a regression where someone adds a
    // surprise trim() and breaks the slugify pipeline.
    expect(isReservedSlug("   ")).toBe(false);
    expect(isReservedSlug(" tags ")).toBe(false);
  });

  it("returns false for slugs that merely contain a reserved word as a substring", () => {
    // Reserved match is exact (case-insensitive), not substring.
    expect(isReservedSlug("my-tags")).toBe(false);
    expect(isReservedSlug("tags-list")).toBe(false);
    expect(isReservedSlug("apifoo")).toBe(false);
    expect(isReservedSlug("authority")).toBe(false);
    expect(isReservedSlug("administrative")).toBe(false);
  });
});

describe("Bidirectional check — workflow.listedSlug AND publicTags.slug", () => {
  // HUB-15 contract per UI-SPEC: `RESERVED_SLUGS` covers all 9 entries;
  // `isReservedSlug("tags")` true; workflow-create with `listedSlug: "tags"`
  // rejected; public-tag-create with `slug: "defi"` does not collide.
  //
  // This block asserts the SHARED validator behaves identically for both
  // call sites. Both `app/api/workflows/[workflowId]/route.ts` and
  // `app/api/public-tags/route.ts` import `isReservedSlug` from the same
  // module; so a single function-level assertion suffices to prove they
  // share the rule.

  it("rejects every reserved word when used as a workflow listedSlug", () => {
    for (const slug of RESERVED_SLUGS) {
      // Simulates the validator branch in
      // app/api/workflows/[workflowId]/route.ts (HUB-11).
      expect(isReservedSlug(slug)).toBe(true);
    }
  });

  it("rejects every reserved word when used as a publicTags slug", () => {
    for (const slug of RESERVED_SLUGS) {
      // Simulates the validator branch in
      // app/api/public-tags/route.ts (HUB-11).
      expect(isReservedSlug(slug)).toBe(true);
    }
  });

  it("accepts the same valid slug across both validators (no collision)", () => {
    // public-tag-create with slug='defi' must NOT collide with reserved set;
    // workflow listedSlug='defi' must also pass the same gate.
    expect(isReservedSlug("defi")).toBe(false);
    expect(isReservedSlug("lending")).toBe(false);
  });

  it("rules differ from no-op: a known reserved word is rejected and a known free word is accepted in one assertion", () => {
    // Sanity assertion: the validator is a real predicate, not a constant.
    expect(isReservedSlug("tags")).toBe(true);
    expect(isReservedSlug("defi")).toBe(false);
    expect(isReservedSlug("tags") === isReservedSlug("defi")).toBe(false);
  });
});
