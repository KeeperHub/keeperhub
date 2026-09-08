/**
 * Manual: submits setAgentURI(agentId, newURI) on the ERC-8004 Identity Registry.
 *
 * This is the on-chain half of the IPFS-pin workflow. The pin step (CI) tells
 * you the new ipfs://<cid>; this script updates the on-chain pointer so
 * indexers (8004scan, etc.) see the content-addressed URI and clear WA040.
 *
 * Run from a trusted machine (not CI). Caller must hold the agent's owner key.
 *
 * Required env:
 *   REGISTRATION_PRIVATE_KEY  - Owner EOA private key (the wallet that registered agentId)
 *   NEW_AGENT_URI             - The new agentURI, e.g. ipfs://bafy...
 *
 * Optional env:
 *   AGENT_ID                       - defaults to KEEPERHUB_ERC_8004_AGENT_ID
 *   IDENTITY_REGISTRY_ADDRESS      - defaults to ERC_8004_IDENTITY_REGISTRY_ADDRESS
 *                                    (both from lib/agentic-wallet/constants.ts)
 *   CHAIN_ETH_MAINNET_PRIMARY_RPC  - default https://chain.techops.services/eth-mainnet
 *
 * Run: pnpm tsx scripts/update-agent-uri.ts
 */

import "dotenv/config";
import { ethers } from "ethers";
import {
  ERC_8004_IDENTITY_REGISTRY_ADDRESS,
  KEEPERHUB_ERC_8004_AGENT_ID,
} from "../lib/agentic-wallet/constants";
import { formatSanitizedRpcError } from "../lib/rpc/sanitize-rpc-error";

const DEFAULT_AGENT_ID = String(KEEPERHUB_ERC_8004_AGENT_ID);
const DEFAULT_REGISTRY = ERC_8004_IDENTITY_REGISTRY_ADDRESS;
const DEFAULT_RPC = "https://eth.llamarpc.com";

// Conservative floor for setAgentURI gas. The call is a single SSTORE plus a
// string write; on mainnet at typical gas prices this is ~$1-3, but we want to
// fail fast if the wallet is empty rather than mid-tx.
const MIN_BALANCE_WEI = BigInt("3000000000000000"); // 0.003 ETH

const SET_AGENT_URI_ABI = [
  {
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    name: "setAgentURI",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "tokenId", type: "uint256" }],
    name: "tokenURI",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "tokenId", type: "uint256" }],
    name: "ownerOf",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export type UpdateResult = { txHash: string; agentId: string; newURI: string };

export async function updateAgentURI(): Promise<UpdateResult> {
  const privateKey = process.env.REGISTRATION_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("REGISTRATION_PRIVATE_KEY environment variable is required");
  }

  const newURI = process.env.NEW_AGENT_URI;
  if (!newURI) {
    throw new Error("NEW_AGENT_URI environment variable is required (e.g. ipfs://bafy...)");
  }

  const agentId = process.env.AGENT_ID ?? DEFAULT_AGENT_ID;
  const registry = process.env.IDENTITY_REGISTRY_ADDRESS ?? DEFAULT_REGISTRY;
  const rpcUrl = process.env.CHAIN_ETH_MAINNET_PRIMARY_RPC ?? DEFAULT_RPC;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(
    registry,
    SET_AGENT_URI_ABI as unknown as ethers.InterfaceAbi,
    wallet
  );

  // Verify the wallet actually owns the token before sending; setAgentURI
  // reverts on a non-owner caller, but we'd rather print a clear preflight
  // error than dispatch a doomed tx and pay gas for the revert.
  const owner = (await contract.ownerOf(agentId)) as string;
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `Wallet ${wallet.address} does not own agent ${agentId} (current owner: ${owner})`
    );
  }

  const currentURI = (await contract.tokenURI(agentId)) as string;
  if (currentURI === newURI) {
    console.log(`On-chain agentURI for agent ${agentId} is already ${newURI}; nothing to do.`);
    return { txHash: "", agentId, newURI };
  }

  const balance = await provider.getBalance(wallet.address);
  if (balance < MIN_BALANCE_WEI) {
    throw new Error(
      `Wallet ${wallet.address} has insufficient balance: ${balance} wei (minimum ${MIN_BALANCE_WEI} wei / 0.003 ETH required for gas)`
    );
  }

  console.log(`Updating agent ${agentId} URI:`);
  console.log(`  from: ${currentURI}`);
  console.log(`  to:   ${newURI}`);

  const tx = (await contract.setAgentURI(agentId, newURI)) as ethers.TransactionResponse;
  console.log(`Transaction sent: ${tx.hash}`);

  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(
      `Transaction ${tx.hash} reverted on-chain (receipt status=${receipt?.status ?? "null"})`
    );
  }

  console.log(`Update confirmed in block ${receipt.blockNumber}.`);
  return { txHash: tx.hash, agentId, newURI };
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("update-agent-uri.ts") ||
    process.argv[1].endsWith("update-agent-uri.js"));

if (isMain) {
  updateAgentURI().catch((err) => {
    console.error("Update failed:", formatSanitizedRpcError(err));
    process.exit(1);
  });
}
