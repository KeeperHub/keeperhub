import { ethers } from "ethers";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  getSearcherWallet,
  SearcherKeyError,
} from "@/lib/web3/bundles/searcher-key";
import { flashbotsSignature } from "@/lib/web3/bundles/signature";

const KEY = `0x${"11".repeat(32)}`;
// Derived, not written out: the key's address is an EOA, not a contract.
const ADDRESS = new ethers.Wallet(KEY).address;
const BODY =
  '{"jsonrpc":"2.0","id":1,"method":"eth_sendBundle","params":[{"txs":["0x02f8"],"blockNumber":"0x10","revertingTxHashes":[]}]}';

describe("flashbotsSignature", () => {
  it("gives a known header for a fixed key and body", async () => {
    const header = await flashbotsSignature(new ethers.Wallet(KEY), BODY);
    expect(header).toBe(
      `${ADDRESS}:0xf0f7ad367cf51cab63cb67ca5685ec8ff9160d29d99064b99123568b78002fb643ed497cd8d4cad85061d04f44dcb83a93f848f3749d8c2814dfdf2f777b50c91b`
    );
  });

  it("signs the keccak hex of the exact body, recoverable to the searcher", async () => {
    const header = await flashbotsSignature(new ethers.Wallet(KEY), BODY);
    const [address, signature] = header.split(":");
    expect(ethers.verifyMessage(ethers.id(BODY), signature)).toBe(address);
    // One changed byte no longer recovers to the searcher.
    expect(ethers.verifyMessage(ethers.id(`${BODY} `), signature)).not.toBe(
      address
    );
  });
});

describe("getSearcherWallet", () => {
  it("reads a 0x or bare 32-byte hex key", () => {
    expect(getSearcherWallet(KEY).address).toBe(ADDRESS);
    expect(getSearcherWallet("11".repeat(32)).address).toBe(ADDRESS);
  });

  it.each([
    undefined,
    "",
    "0x1234",
    `0x${"zz".repeat(32)}`,
    `0x${"00".repeat(32)}`,
  ])("refuses %s without echoing it", (raw) => {
    let caught: unknown;
    try {
      getSearcherWallet(raw);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SearcherKeyError);
    const message = (caught as Error).message;
    expect(message).toContain("BUNDLE_SEARCHER_PRIVATE_KEY");
    if (raw) {
      expect(message).not.toContain(raw);
    }
  });

  it("reads BUNDLE_SEARCHER_PRIVATE_KEY by default", () => {
    vi.stubEnv("BUNDLE_SEARCHER_PRIVATE_KEY", KEY);
    expect(getSearcherWallet().address).toBe(ADDRESS);
    vi.unstubAllEnvs();
  });
});
