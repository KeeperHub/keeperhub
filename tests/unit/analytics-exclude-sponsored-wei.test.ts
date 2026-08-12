import { describe, expect, it, vi } from "vitest";

// queries.ts is a server-only module that also pulls in the db client; stub
// both so the pure excludeSponsoredWei helper can be imported under vitest
// without resolving the server-only marker or opening a DB connection.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { excludeSponsoredWei } from "@/lib/analytics/queries";

describe("excludeSponsoredWei", () => {
  it("subtracts the sponsored slice out of the gross wallet-side total", () => {
    // One sponsored mainnet transfer at 21000 units and 1 gwei: the
    // gas_credit_usage ledger and the run-level gas_used_wei rollup both
    // record the same 21000000000000 wei cost (KEEP fix in
    // sponsored-transaction-manager.ts). Subtracting the sponsored slice
    // back out leaves the wallet side at 0, matching what the org's own
    // wallet actually paid.
    expect(excludeSponsoredWei("21000000000000", "21000000000000")).toBe("0");
  });

  it("keeps the wallet-only portion when gross mixes sponsored and wallet gas", () => {
    // A run with one wallet-paid step (21000000000000 wei) and one sponsored
    // step (21000000000000 wei) rolls up to 42000000000000 gross; only the
    // wallet-paid half should remain after excluding the sponsored ledger total.
    expect(excludeSponsoredWei("42000000000000", "21000000000000")).toBe(
      "21000000000000"
    );
  });

  it("passes through unsponsored gas untouched", () => {
    expect(excludeSponsoredWei("21000000000000", "0")).toBe("21000000000000");
  });

  it("floors at zero instead of going negative", () => {
    // Guards the mixed-unit historical-data known-gap (pre-fix rows still
    // hold raw gas units): a sponsored total that exceeds gross must not
    // push the KPI negative.
    expect(excludeSponsoredWei("100", "500")).toBe("0");
  });

  it("treats missing strings as zero", () => {
    expect(excludeSponsoredWei("", "")).toBe("0");
  });
});
