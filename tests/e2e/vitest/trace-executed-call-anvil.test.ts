/**
 * Call tracing against a real node (local anvil).
 *
 * Two contracts are placed with anvil_setCode: a target that accepts any call,
 * and a wrapper that forwards its calldata to the target, the way a gas relayer
 * does. Real transactions to each are traced through the provider manager, so
 * the decode runs on the node's own callTracer output rather than a fixture.
 *
 * Prerequisites: docker compose --profile test up -d test-anvil
 * (Foundry anvil on localhost:8546, chain-id 31337.)
 *
 * Skipped when SKIP_INFRA_TESTS=true or when anvil is not reachable. Runs
 * with SAFE_FETCH_SHADOW so the SSRF guard lets the provider reach localhost.
 */

import { ethers } from "ethers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { RpcProviderManager } from "@/lib/rpc/providers";
import type * as Trace from "@/lib/web3/trace-executed-call";

const ANVIL_URL = process.env.ANVIL_URL ?? "http://localhost:8546";
const CHAIN_ID = 31_337;
const ANVIL_PRIV_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TARGET = "0x00000000000000000000000000000000000c0de2";
const WRAPPER = "0x00000000000000000000000000000000000c0de3";
// Accepts any call: STOP.
const TARGET_CODE = "0x00";
// Copies its calldata and CALLs TARGET with it, ignoring the result.
const WRAPPER_CODE = `0x36600060003760006000366000600073${TARGET.slice(2)}5af15000`;
const ABI = ["function transfer(address to, uint256 amount) returns (bool)"];
const IFACE = new ethers.Interface(ABI);

async function isAnvilReachable(): Promise<boolean> {
  try {
    const response = await fetch(ANVIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", id: 1 }),
      signal: AbortSignal.timeout(1000),
    });
    const body = (await response.json()) as { result?: string };
    return body.result === `0x${CHAIN_ID.toString(16)}`;
  } catch {
    return false;
  }
}

const skipForCi = process.env.SKIP_INFRA_TESTS === "true";
const shouldSkip = skipForCi || !(await isAnvilReachable());

describe.skipIf(shouldSkip)("traceExecutedCallWithFailover (anvil E2E)", () => {
  let provider: ethers.JsonRpcProvider;
  let rpcManager: RpcProviderManager;
  let wallet: ethers.Wallet;
  let trace: typeof Trace;

  async function sendTransfer(to: string): Promise<string> {
    const tx = await wallet.sendTransaction({
      to,
      data: IFACE.encodeFunctionData("transfer", [RECIPIENT, BigInt(5)]),
      gasLimit: BigInt(100_000),
    });
    const receipt = await tx.wait();
    expect(receipt?.status).toBe(1);
    return tx.hash;
  }

  beforeAll(async () => {
    vi.stubEnv("SAFE_FETCH_SHADOW", "true");
    const { getRpcProviderFromUrls } = await import(
      "@/lib/rpc/provider-factory"
    );
    trace = await import("@/lib/web3/trace-executed-call");
    rpcManager = await getRpcProviderFromUrls(
      ANVIL_URL,
      undefined,
      CHAIN_ID,
      "anvil-trace-test"
    );
    provider = new ethers.JsonRpcProvider(ANVIL_URL, CHAIN_ID, {
      staticNetwork: true,
    });
    wallet = new ethers.Wallet(ANVIL_PRIV_0, provider);
    await provider.send("anvil_setCode", [TARGET, TARGET_CODE]);
    await provider.send("anvil_setCode", [WRAPPER, WRAPPER_CODE]);
  });

  afterAll(() => {
    provider?.destroy();
    vi.unstubAllEnvs();
  });

  it("decodes a direct call from the node's trace", {
    timeout: 30_000,
  }, async () => {
    const hash = await sendTransfer(TARGET);

    const executed = await trace.traceExecutedCallWithFailover(
      rpcManager,
      hash,
      {
        target: TARGET,
        abi: ABI,
        functionName: "transfer",
      }
    );

    expect(executed).toMatchObject({
      contractAddress: TARGET,
      from: wallet.address.toLowerCase(),
      functionName: "transfer",
      functionSignature: "transfer(address,uint256)",
      sponsored: false,
      topLevelTo: TARGET,
      reverted: false,
    });
    expect(executed?.args.to?.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(executed?.args.amount).toBe("5");
  });

  it("finds the inner call when a wrapper forwards it", {
    timeout: 30_000,
  }, async () => {
    const hash = await sendTransfer(WRAPPER);

    const executed = await trace.traceExecutedCallWithFailover(
      rpcManager,
      hash,
      {
        target: TARGET,
        abi: ABI,
        functionName: "transfer",
      }
    );

    expect(executed).toMatchObject({
      contractAddress: TARGET,
      from: WRAPPER,
      functionName: "transfer",
      sponsored: true,
      topLevelTo: WRAPPER,
      reverted: false,
    });
    expect(executed?.args.amount).toBe("5");
  });
});
