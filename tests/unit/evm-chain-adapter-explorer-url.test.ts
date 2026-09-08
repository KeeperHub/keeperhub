import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/web3/chain-adapter/explorer", () => ({
  buildChainTransactionUrl: vi.fn(),
  buildChainAddressUrl: vi.fn(),
}));

import { EvmChainAdapter } from "@/lib/web3/chain-adapter/evm";
import {
  buildChainAddressUrl,
  buildChainTransactionUrl,
} from "@/lib/web3/chain-adapter/explorer";

const CHAIN_ID = 1;
const TX_HASH = "0xabc";
const ADDRESS = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb";

function makeAdapter(): EvmChainAdapter {
  // gasStrategy and nonceManager are unused by the URL methods under test.
  return new EvmChainAdapter(
    CHAIN_ID,
    {} as unknown as ConstructorParameters<typeof EvmChainAdapter>[1],
    {} as unknown as ConstructorParameters<typeof EvmChainAdapter>[2]
  );
}

describe("EvmChainAdapter explorer URLs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the built transaction URL", async () => {
    vi.mocked(buildChainTransactionUrl).mockResolvedValue(
      "https://etherscan.io/tx/0xabc"
    );

    await expect(makeAdapter().getTransactionUrl(TX_HASH)).resolves.toBe(
      "https://etherscan.io/tx/0xabc"
    );
  });

  it("degrades to empty string instead of throwing when the tx lookup fails", async () => {
    // A transfer step calls this after the transaction is already mined, so a
    // throw here would flip a completed transfer's result to failed.
    vi.mocked(buildChainTransactionUrl).mockRejectedValue(
      new Error("explorer config lookup failed")
    );

    await expect(makeAdapter().getTransactionUrl(TX_HASH)).resolves.toBe("");
  });

  it("degrades to empty string instead of throwing when the address lookup fails", async () => {
    vi.mocked(buildChainAddressUrl).mockRejectedValue(
      new Error("explorer config lookup failed")
    );

    await expect(makeAdapter().getAddressUrl(ADDRESS)).resolves.toBe("");
  });
});
