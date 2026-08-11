import { ethers } from "ethers";

const ANVIL_RPC = process.env.ANVIL_RPC_URL ?? "http://localhost:8546";
const ANVIL_WSS = process.env.ANVIL_WSS_URL ?? "ws://localhost:8546";
const ANVIL_CHAIN_ID = 31337;

// Anvil's first well-known test account. Never used on any mainnet.
const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export function getAnvilRpcUrl(): string {
  return ANVIL_RPC;
}

export function getAnvilWssUrl(): string {
  return ANVIL_WSS;
}

export function getAnvilChainId(): number {
  return ANVIL_CHAIN_ID;
}

export function getAnvilWallet(): ethers.Wallet {
  const provider = new ethers.JsonRpcProvider(ANVIL_RPC);
  return new ethers.Wallet(ANVIL_PRIVATE_KEY, provider);
}

export async function waitForAnvil(maxMs = 30_000): Promise<void> {
  const provider = new ethers.JsonRpcProvider(ANVIL_RPC);
  const deadline = Date.now() + maxMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await provider.getBlockNumber();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(
    `Anvil not reachable at ${ANVIL_RPC} within ${maxMs}ms: ${String(lastErr)}`,
  );
}
