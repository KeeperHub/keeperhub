/**
 * Pins data/agent-registry.json to Pinata and reports the resulting IPFS CID.
 *
 * Compares the new CID against the on-chain agentURI (read via tokenURI on the
 * ERC-8004 Identity Registry). If they differ, prints the manual command to
 * submit the on-chain update tx. The script never sends a transaction itself --
 * the owner private key stays out of CI.
 *
 * Required env:
 *   PINATA_JWT - Pinata API JWT (https://app.pinata.cloud/developers/api-keys)
 *
 * Optional env:
 *   AGENT_ID                       - defaults to KEEPERHUB_ERC_8004_AGENT_ID
 *   IDENTITY_REGISTRY_ADDRESS      - defaults to ERC_8004_IDENTITY_REGISTRY_ADDRESS
 *                                    (both from lib/agentic-wallet/constants.ts)
 *   CHAIN_ETH_MAINNET_PRIMARY_RPC  - if set, used as the only RPC; otherwise
 *                                    the script tries a list of public RPCs
 *                                    in sequence and uses the first that works
 *
 * Run: pnpm tsx scripts/pin-agent-card.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import {
  ERC_8004_IDENTITY_REGISTRY_ADDRESS,
  KEEPERHUB_ERC_8004_AGENT_ID,
} from "../lib/agentic-wallet/constants";
import { formatSanitizedRpcError } from "../lib/rpc/sanitize-rpc-error";

const DEFAULT_AGENT_ID = String(KEEPERHUB_ERC_8004_AGENT_ID);
const DEFAULT_REGISTRY = ERC_8004_IDENTITY_REGISTRY_ADDRESS;

// Public mainnet RPCs tried in order. CDN-fronted endpoints regularly serve
// Cloudflare challenge pages to GHA runner IPs, so we try a list and accept
// the first that responds. All entries verified against eth_call /
// tokenURI(31875) on 2026-05-08.
const FALLBACK_RPCS: readonly string[] = [
  "https://ethereum-rpc.publicnode.com",
  "https://1rpc.io/eth",
  "https://eth.drpc.org",
  "https://eth.llamarpc.com",
] as const;

function envOrDefault(key: string, fallback: string): string {
  const value = process.env[key];
  // GHA passes ${{ secrets.X }} as "" when X is unset, so treat empty as missing.
  return value && value.length > 0 ? value : fallback;
}
const PINATA_PIN_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const CARD_PATH = join(process.cwd(), "data/agent-registry.json");

const TOKEN_URI_ABI = [
  {
    inputs: [{ name: "tokenId", type: "uint256" }],
    name: "tokenURI",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

type PinataResponse = {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
};

async function pinToPinata(jwt: string, bytes: Buffer): Promise<PinataResponse> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/json" });
  form.append("file", blob, "agent-registry.json");
  form.append(
    "pinataMetadata",
    JSON.stringify({ name: "keeperhub-agent-registry" })
  );
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const resp = await fetch(PINATA_PIN_FILE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Pinata pin failed: ${resp.status} ${resp.statusText} -- ${body}`);
  }

  return (await resp.json()) as PinataResponse;
}

async function readOnchainAgentURI(
  rpcUrls: readonly string[],
  registry: string,
  agentId: string
): Promise<string | null> {
  for (const rpcUrl of rpcUrls) {
    try {
      // staticNetwork avoids the eth_chainId roundtrip that 403'd against
      // CDN-fronted RPCs returning a Cloudflare challenge instead of JSON-RPC.
      const provider = new ethers.JsonRpcProvider(rpcUrl, 1, {
        staticNetwork: true,
      });
      const contract = new ethers.Contract(
        registry,
        TOKEN_URI_ABI as unknown as ethers.InterfaceAbi,
        provider
      );
      const result = (await contract.tokenURI(agentId)) as string;
      console.log(`[pin] Drift check via ${rpcUrl}`);
      return result;
    } catch (err) {
      const message = formatSanitizedRpcError(err);
      console.warn(`[pin] RPC ${rpcUrl} unavailable: ${message.split("\n")[0]}`);
    }
  }
  return null;
}

export async function pinAgentCard(): Promise<void> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    throw new Error("PINATA_JWT environment variable is required");
  }

  const agentId = envOrDefault("AGENT_ID", DEFAULT_AGENT_ID);
  const registry = envOrDefault("IDENTITY_REGISTRY_ADDRESS", DEFAULT_REGISTRY);
  const customRpc = process.env.CHAIN_ETH_MAINNET_PRIMARY_RPC;
  const rpcUrls: readonly string[] =
    customRpc && customRpc.length > 0 ? [customRpc] : FALLBACK_RPCS;

  const bytes = readFileSync(CARD_PATH);
  console.log(`[pin] Pinning ${CARD_PATH} (${bytes.length} bytes) to Pinata...`);

  const pinned = await pinToPinata(jwt, bytes);
  const newUri = `ipfs://${pinned.IpfsHash}`;
  console.log(`[pin] Pinned: ${newUri}`);
  console.log(`[pin] Gateway: https://gateway.pinata.cloud/ipfs/${pinned.IpfsHash}`);

  // Drift check is best-effort: pinning is the primary success criterion. If
  // every public RPC is rate-limited or behind a CF challenge, log a warning
  // and exit cleanly -- the operator can still run update-agent-uri locally.
  const currentUri = await readOnchainAgentURI(rpcUrls, registry, agentId);
  if (currentUri === null) {
    console.warn(
      "[pin] Could not read on-chain agentURI from any public RPC; skipping drift check."
    );
    console.warn(
      `[pin] Pinned CID is ${newUri}. To update on-chain manually, run locally:`
    );
    console.warn(
      `  REGISTRATION_PRIVATE_KEY=<owner-key> NEW_AGENT_URI="${newUri}" pnpm update-agent-uri`
    );
    return;
  }

  console.log(`[pin] On-chain agentURI for agent ${agentId}: ${currentUri}`);

  if (currentUri === newUri) {
    console.log("[pin] No drift -- on-chain agentURI already matches the pinned CID.");
    return;
  }

  console.log("[pin] DRIFT DETECTED. To update the on-chain agentURI, run locally:");
  console.log("");
  console.log(`  REGISTRATION_PRIVATE_KEY=<owner-key> NEW_AGENT_URI="${newUri}" \\`);
  console.log("    pnpm tsx scripts/update-agent-uri.ts");
  console.log("");
  console.log(
    "[pin] (The pinned content is durable on Pinata; the on-chain pointer just hasn't been updated yet.)"
  );
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("pin-agent-card.ts") ||
    process.argv[1].endsWith("pin-agent-card.js"));

if (isMain) {
  pinAgentCard().catch((err) => {
    console.error("[pin] Failed:", formatSanitizedRpcError(err));
    process.exit(1);
  });
}
