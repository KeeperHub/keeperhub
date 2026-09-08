#!/usr/bin/env tsx

/**
 * frax-ether-v2-fork-test.ts
 *
 * Smoke-test the Frax Ether V2 minter against a local anvil mainnet
 * fork so the write path (mintFrxEth) can be exercised without
 * spending real ETH. Frax Ether V2 has no testnet deployment - the V2
 * minter contract lives only on Ethereum mainnet - so a forked node
 * with mainnet bytecode is the only way to dry-run the broadcast end
 * of the stack.
 *
 * Setup (in a second terminal):
 *
 *   docker run --rm -p 8545:8545 ghcr.io/foundry-rs/foundry:v1.7.1 \
 *     "anvil --host 0.0.0.0 --fork-url <YOUR_MAINNET_RPC_URL>"
 *
 *   Pin a version rather than `latest` or `stable` - on GHCR `latest`
 *   is foundry's nightly tag, whose contents change daily and have
 *   shipped anvil builds that cannot fork some chains at all, and
 *   `stable` is unmaintained and lags the newest release.
 *
 *   The MAINNET_RPC_URL must be an archive-capable RPC; a free public
 *   RPC tends to rate-limit anvil's fork loads. Do NOT pass --chain-id
 *   so anvil inherits mainnet's id (1).
 *
 * Run:
 *
 *   pnpm tsx scripts/frax-ether-v2-fork-test.ts
 *
 * Override the anvil URL:
 *
 *   ANVIL_URL=http://localhost:9999 pnpm tsx scripts/frax-ether-v2-fork-test.ts
 *
 * What it does:
 *   1. Connects to the anvil fork and verifies chain id 1 + bytecode
 *      at the V2 minter address.
 *   2. Uses anvil's first pre-funded account (10000 ETH).
 *   3. Reads mintFrxEthPaused() through the forked bytecode.
 *   4. Broadcasts mintFrxEth() with 1 ETH value.
 *   5. Reads the resulting frxETH balance and asserts a ~1:1 mint.
 */

import { ethers } from "ethers";
import fraxEtherV2Abi from "@/protocols/abis/frax-ether-v2.json";
import { formatSanitizedRpcError } from "../lib/rpc/sanitize-rpc-error";

const ANVIL_URL = process.env.ANVIL_URL ?? "http://localhost:8545";

// First account from anvil's default mnemonic ("test test test ...").
// Pre-funded with 10000 ETH on every fresh anvil. This is a well-known
// foundry test key with no value outside a local devnet.
const ANVIL_ACCOUNT_0_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const MINTER_V2_ADDRESS = "0x7Bc6bad540453360F744666D625fec0ee1320cA3";
const FRXETH_TOKEN_ADDRESS = "0x5E8422345238F34275888049021821E8E08CAa1f";

const FRXETH_ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
] as const;

const ONE_ETH = ethers.parseEther("1");
const MINT_TOLERANCE = ethers.parseEther("0.001");
const MAINNET_CHAIN_ID = BigInt(1);

function fmtEth(wei: bigint): string {
  return `${ethers.formatEther(wei)} ETH`;
}

async function assertOnMainnetFork(
  provider: ethers.JsonRpcProvider
): Promise<void> {
  const network = await provider.getNetwork();
  if (network.chainId !== MAINNET_CHAIN_ID) {
    throw new Error(
      `Expected chain id 1 (anvil --fork-url mainnet), got ${network.chainId}. ` +
        "Restart anvil without --chain-id so it inherits mainnet's id."
    );
  }
  const code = await provider.getCode(MINTER_V2_ADDRESS);
  if (code === "0x") {
    throw new Error(
      `No bytecode at ${MINTER_V2_ADDRESS} on the fork. ` +
        "The fork is not pointing at Ethereum mainnet."
    );
  }
}

async function main(): Promise<void> {
  console.log(`Connecting to anvil fork at ${ANVIL_URL}`);
  const provider = new ethers.JsonRpcProvider(ANVIL_URL);

  await assertOnMainnetFork(provider);

  const wallet = new ethers.Wallet(ANVIL_ACCOUNT_0_PRIVATE_KEY, provider);
  console.log(`Sender: ${wallet.address}`);

  const minter = new ethers.Contract(
    MINTER_V2_ADDRESS,
    fraxEtherV2Abi as ethers.InterfaceAbi,
    wallet
  );
  const frxEth = new ethers.Contract(
    FRXETH_TOKEN_ADDRESS,
    FRXETH_ERC20_ABI,
    provider
  );

  const paused = (await minter.mintFrxEthPaused()) as boolean;
  console.log(`mintFrxEthPaused() = ${paused}`);
  if (paused) {
    throw new Error("V2 minter is paused on mainnet, cannot test mint.");
  }

  const beforeBalance = (await frxEth.balanceOf(wallet.address)) as bigint;
  console.log(`frxETH before: ${fmtEth(beforeBalance)}`);

  console.log("Broadcasting mintFrxEth() with 1 ETH value ...");
  const tx = await minter.mintFrxEth({ value: ONE_ETH });
  const receipt = await tx.wait();
  console.log(
    `Tx ${receipt?.hash ?? "<unknown>"} mined in block ${
      receipt?.blockNumber ?? "<unknown>"
    }`
  );

  const afterBalance = (await frxEth.balanceOf(wallet.address)) as bigint;
  console.log(`frxETH after:  ${fmtEth(afterBalance)}`);

  const minted = afterBalance - beforeBalance;
  console.log(`Minted:        ${fmtEth(minted)}`);

  const lowerBound = ONE_ETH - MINT_TOLERANCE;
  const upperBound = ONE_ETH + MINT_TOLERANCE;
  if (minted < lowerBound || minted > upperBound) {
    throw new Error(
      `Expected ~1 frxETH minted (tolerance ${fmtEth(MINT_TOLERANCE)}), ` +
        `got ${fmtEth(minted)}.`
    );
  }
  console.log("\nPASS: mintFrxEth produced ~1:1 frxETH on the mainnet fork.");
}

main().catch((err: unknown) => {
  console.error(`\nFAIL: ${formatSanitizedRpcError(err)}`);
  process.exit(1);
});
