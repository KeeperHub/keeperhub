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
  it("uses the structural pre-broadcast tag instead of error text", () => {
    expect(source).toContain("isPreBroadcastNetworkError(error)");
    expect(source).toMatch(
      /broadcastAttempted:[\s\S]{0,240}isPreBroadcastNetworkError\(error\)/
    );
  });
  it("fails closed when no structural tag is present", () => {
    expect(source).not.toMatch(
      /broadcastAttempted:[\s\S]{0,240}(?:ECONNREFUSED|connection refused)/i
    );
  });
});
