import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const IMPORT_RELATIVE_TURNKEY_OPERATIONS =
  /from ["']\.\/turnkey-operations["']/;
const IMPORT_ALIAS_TURNKEY_OPERATIONS =
  /from ["']@\/lib\/turnkey\/turnkey-operations["']/;
const AGENTIC_RPID_DEFINITION = /AGENTIC_RPID\s*=\s*["']([^"']+)["']/g;
const EXPORT_CREATE_AGENTIC_WALLET =
  /export\s+(async\s+)?function\s+createAgenticWallet/;
const EXPORT_GET_TURNKEY_CLIENT_FOR_ORG =
  /export\s+function\s+getTurnkeyClientForOrg/;

const TURNKEY_DIR = join(process.cwd(), "lib/turnkey");
const AGENTIC_FILENAME = /^agentic-.+\.ts$/;

/**
 * Every `lib/turnkey/agentic-*.ts` file is inside the v1.8 custody boundary
 * and MUST NOT pull in creator-wallet helpers from `./turnkey-operations`.
 * Scanning the whole prefix (not just `agentic-wallet.ts`) keeps the invariant
 * live as Phase 33 and later waves grow the module (e.g. `agentic-signing.ts`,
 * `agentic-approval.ts`).
 */
const agenticFiles: { path: string; source: string }[] = readdirSync(
  TURNKEY_DIR
)
  .filter((name) => AGENTIC_FILENAME.test(name))
  .map((name) => ({
    path: join(TURNKEY_DIR, name),
    source: readFileSync(join(TURNKEY_DIR, name), "utf8"),
  }));

describe("agentic-wallet module boundary: directory-wide scan", () => {
  it("discovers at least one agentic-* file", () => {
    expect(agenticFiles.length).toBeGreaterThan(0);
  });

  it("includes agentic-wallet.ts in the scan", () => {
    const names = agenticFiles.map((f) => f.path);
    expect(names.some((p) => p.endsWith("agentic-wallet.ts"))).toBe(true);
  });

  for (const { path, source } of agenticFiles) {
    describe(`boundary checks: ${path.replace(`${process.cwd()}/`, "")}`, () => {
      it("does not import from turnkey-operations", () => {
        expect(source).not.toMatch(IMPORT_RELATIVE_TURNKEY_OPERATIONS);
        expect(source).not.toMatch(IMPORT_ALIAS_TURNKEY_OPERATIONS);
      });

      it("does not reference createTurnkeyWallet", () => {
        expect(source).not.toContain("createTurnkeyWallet");
      });

      it("does not leak app.keeperhub.com variant", () => {
        expect(source).not.toContain("app.keeperhub.com");
      });
    });
  }
});

describe("agentic-wallet.ts: file-specific invariants", () => {
  const source = readFileSync(
    join(process.cwd(), "lib/turnkey/agentic-wallet.ts"),
    "utf8"
  );

  // The module defined an AGENTIC_RPID passkey relying-party id that nothing
  // ever imported, and there is no WebAuthn code in the tree. It was removed
  // rather than made configurable. This asserts it stays gone, so a future
  // passkey feature has to choose its relying-party id deliberately instead of
  // inheriting a hardcoded keeperhub.com from a constant nobody remembers.
  it("defines no AGENTIC_RPID", () => {
    expect(source.match(AGENTIC_RPID_DEFINITION)).toBeNull();
  });

  it("exports createAgenticWallet and getTurnkeyClientForOrg", () => {
    expect(source).toMatch(EXPORT_CREATE_AGENTIC_WALLET);
    expect(source).toMatch(EXPORT_GET_TURNKEY_CLIENT_FOR_ORG);
  });
});
