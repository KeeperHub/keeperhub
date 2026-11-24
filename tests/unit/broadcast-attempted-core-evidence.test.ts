import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cores = [
  "plugins/web3/steps/approve-token-core.ts",
  "plugins/web3/steps/batch-write-contract-core.ts",
  "plugins/web3/steps/transfer-funds-core.ts",
  "plugins/web3/steps/transfer-token-core.ts",
  "plugins/web3/steps/write-contract-core.ts",
  "plugins/robinhood/steps/trade-stock-token-core.ts",
] as const;

describe.each(cores)("%s broadcastAttempted evidence", (path) => {
  const source = readFileSync(path, "utf8");
  // One helper: a refused connection, a failed next-block check, a Gas Limit too low.
  it("uses the structural pre-send tags instead of error text", () => {
    expect(source).toContain("isDefinitelyPreSend(error)");
    expect(source).toMatch(
      /broadcastAttempted:[\s\S]{0,240}isDefinitelyPreSend\(error\)/
    );
  });
  it("fails closed when no structural tag is present", () => {
    expect(source).not.toMatch(
      /broadcastAttempted:[\s\S]{0,240}(?:ECONNREFUSED|connection refused)/i
    );
  });
});
