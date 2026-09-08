import { describe, expect, it, vi } from "vitest";

// execution-service pulls in server-only + the DB client at module load; stub
// them so we can import the pure helper without a database.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ directExecutions: {} }));

import { withRejectedSignerOverride } from "@/app/api/execute/_lib/execution-service";

describe("withRejectedSignerOverride", () => {
  it("returns the base unchanged when the caller sent no web3Connection", () => {
    const base = {
      actionType: "web3/write-contract",
      contractAddress: "0xabc",
    };
    const result = withRejectedSignerOverride(base, {
      contractAddress: "0xabc",
    });
    expect(result).toEqual(base);
    expect("_rejectedConfig" in result).toBe(false);
  });

  it("records a non-honored override under _rejectedConfig (pre-stripped base)", () => {
    // The node route passes a base from which web3Connection was already
    // removed, plus the original caller config.
    const result = withRejectedSignerOverride(
      { actionType: "web3/write-contract", contractAddress: "0xabc" },
      { contractAddress: "0xabc", web3Connection: "eoa" }
    );
    expect(result._rejectedConfig).toEqual({ web3Connection: "eoa" });
    expect("web3Connection" in result).toBe(false);
    expect(result.contractAddress).toBe("0xabc");
  });

  it("strips a top-level web3Connection from the base too (sibling body case)", () => {
    // Sibling routes pass the raw body as both base and callerConfig, so the
    // override sits at the top level and must be relocated, not duplicated.
    const body = { contractAddress: "0xabc", web3Connection: "eoa" };
    const result = withRejectedSignerOverride(body, body);
    expect("web3Connection" in result).toBe(false);
    expect(result._rejectedConfig).toEqual({ web3Connection: "eoa" });
    expect(result.contractAddress).toBe("0xabc");
  });

  it("does not mutate the inputs", () => {
    const base = { contractAddress: "0xabc", web3Connection: "eoa" };
    const config = { contractAddress: "0xabc", web3Connection: "eoa" };
    withRejectedSignerOverride(base, config);
    expect(base.web3Connection).toBe("eoa");
    expect(config.web3Connection).toBe("eoa");
  });
});
