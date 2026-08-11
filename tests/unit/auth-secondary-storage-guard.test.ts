/**
 * Guard for the secondaryStorage footgun documented in
 * lib/auth-session-token-hash.ts. The wrapWithSessionTokenHash adapter only
 * hashes session tokens at the database layer. better-auth's createSession
 * writes directly to secondaryStorage.set(rawToken, ...) without calling the
 * DB adapter, so enabling secondaryStorage on the betterAuth() config would
 * land plaintext session tokens in the cache and re-open the "DB/cache read ->
 * replayable token" path the wrapper was built to close.
 *
 * This test fails the moment secondaryStorage appears in lib/auth.ts. If a
 * future change genuinely needs it, re-implement token hashing at the cache
 * layer first, then update this guard to assert the cache wrapper is present.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SECONDARY_STORAGE = /secondaryStorage/;

describe("better-auth secondaryStorage guard", () => {
  it("does not enable secondaryStorage without a cache-layer token-hash wrapper", () => {
    const source = readFileSync(join(process.cwd(), "lib/auth.ts"), "utf8");
    expect(source).not.toMatch(SECONDARY_STORAGE);
  });
});
