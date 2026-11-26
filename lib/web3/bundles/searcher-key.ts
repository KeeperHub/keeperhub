import "server-only";
import { ethers } from "ethers";

const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/** The searcher key is missing or malformed. Never carries the value. */
export class SearcherKeyError extends Error {
  override readonly name = "SearcherKeyError" as const;

  constructor() {
    super("BUNDLE_SEARCHER_PRIVATE_KEY is missing or not a 32-byte hex key");
  }
}

let cached: { raw: string; wallet: ethers.Wallet } | undefined;

/**
 * The platform searcher key, which only signs the X-Flashbots-Signature header.
 * It holds no funds and never signs a transaction.
 */
export function getSearcherWallet(
  raw: string | undefined = process.env.BUNDLE_SEARCHER_PRIVATE_KEY
): ethers.Wallet {
  const value = raw?.trim() ?? "";
  if (cached?.raw === value) {
    return cached.wallet;
  }
  if (!KEY_RE.test(value)) {
    throw new SearcherKeyError();
  }
  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(value.startsWith("0x") ? value : `0x${value}`);
  } catch {
    // Out of the curve's range; ethers' own message is not passed on.
    throw new SearcherKeyError();
  }
  cached = { raw: value, wallet };
  return wallet;
}
