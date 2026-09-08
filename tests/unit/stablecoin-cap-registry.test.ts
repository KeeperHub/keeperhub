/**
 * Guards the approve allowlist against resolving empty in production.
 *
 * The defect: `getRegisteredProtocols()` is populated by import side effect,
 * and of the execute routes only `[...slug]` imported the protocol barrel. On
 * every other path the allowlist resolved empty and refused every over-cap
 * approval to a genuine router -- the exact traffic it was written to permit.
 *
 * Why this is asserted against the source text rather than by behaviour:
 * `tests/setup.ts` does `import "@/plugins"` for the whole suite, which
 * transitively registers every protocol before any test runs. So the registry
 * is populated in-process no matter what the module under test imports, and a
 * behavioural assertion passes identically with the fix reverted. That global
 * setup, not just the registry mock in the sibling suite, is what made the
 * original bug invisible to unit tests.
 *
 * A source-level assertion is blunt, but it fails exactly when the import is
 * removed, which is the regression that matters and the one nothing else
 * catches.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CAP_SOURCE = readFileSync(
  join(process.cwd(), "lib/execute/stablecoin-cap.ts"),
  "utf8"
);

describe("approve allowlist registry population", () => {
  it("imports the protocol barrel for its side effect", () => {
    // Not `from "@/protocols"` -- the import exists only to run registration,
    // so it is bare and a named import would not be equivalent.
    expect(CAP_SOURCE).toMatch(/^import\s+["']@\/protocols["'];$/m);
  });

  // The other half of the fix. Memoising outright meant a protocol registering
  // after the first call was locked out for the life of the process, so the
  // verdict depended on which traffic warmed the module first.
  it("keys the spender cache on registry size rather than memoising once", () => {
    expect(CAP_SOURCE).toContain("knownSpendersFrom");
    expect(CAP_SOURCE).toMatch(/knownSpendersFrom\s*===\s*protocols\.length/);
  });

  // Sanity check on the premise: the allowlist is only meaningful if
  // registered protocols actually carry static addresses to allowlist.
  it("finds concrete spender addresses among registered protocols", async () => {
    const { getRegisteredProtocols } = await import("@/lib/protocol-registry");
    const addresses: string[] = [];
    for (const protocol of getRegisteredProtocols()) {
      for (const contract of Object.values(protocol.contracts ?? {})) {
        if (contract.userSpecifiedAddress) {
          continue;
        }
        for (const address of Object.values(contract.addresses ?? {})) {
          if (typeof address === "string" && address.startsWith("0x")) {
            addresses.push(address);
          }
        }
      }
    }

    expect(addresses.length).toBeGreaterThan(0);
  });
});
