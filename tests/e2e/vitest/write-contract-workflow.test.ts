/**
 * E2E Test: Write-Contract Workflow on Sepolia
 *
 * Verifies the full write-contract step against a SimpleStorage contract on Sepolia.
 * Uses a persistent test org + Para wallet (provisioned by scripts/seed/seed-test-wallet.ts).
 * The persistent wallet must already have sufficient Sepolia ETH for gas.
 *
 * Prerequisites:
 * - Database running with schema pushed (pnpm db:push)
 * - Test org provisioned (pnpm db:seed-test-wallet)
 * - Para API key configured
 *
 * Run: pnpm vitest run tests/e2e/vitest/write-contract-workflow.test.ts
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { ethers } from "ethers";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

// Unmock db for real database access, stub server-only for Node environment
vi.unmock("@/lib/db");
vi.mock("server-only", () => ({}));

import {
  chains,
  organization,
  organizationWallets,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "@/lib/db/schema";
import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { generateId } from "@/lib/utils/id";
import type { WriteContractInput } from "@/plugins/web3/steps/write-contract";

// Skip if infrastructure not available (requires DB + Turnkey for tx signing)
const shouldSkip =
  !(
    process.env.DATABASE_URL &&
    process.env.TURNKEY_API_PUBLIC_KEY &&
    process.env.TURNKEY_API_PRIVATE_KEY
  ) || process.env.SKIP_INFRA_TESTS === "true";

// SimpleStorage contract on Sepolia
const SIMPLE_STORAGE_ADDRESS = "0x069d34E130ccA7D435351FB30c0e97F2Ce6B42Ad";
const SIMPLE_STORAGE_ABI = JSON.stringify([
  {
    inputs: [
      { internalType: "uint256", name: "_favoriteNumber", type: "uint256" },
    ],
    name: "store",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "retrieve",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
]);

const TEST_ORG_SLUG = "e2e-test-org";
const SEPOLIA_CHAIN_ID = 11_155_111;
const MIN_BALANCE = ethers.parseEther("0.0001");

describe.skipIf(shouldSkip)("Write Contract Workflow E2E", () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let sepoliaManager: RpcProviderManager;
  let orgId: string;
  let userId: string;
  let walletAddress: string;
  let sepoliaRpcUrl: string;

  // Test records to clean up
  let testWorkflowId: string;
  let testExecutionId: string;

  beforeAll(async () => {
    // Connect to database
    const connectionString =
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5433/keeperhub";

    client = postgres(connectionString, { max: 5 });
    db = drizzle(client);

    // Look up Sepolia RPC from chains table
    const sepoliaChain = await db
      .select()
      .from(chains)
      .where(eq(chains.chainId, SEPOLIA_CHAIN_ID))
      .limit(1);

    if (sepoliaChain.length === 0) {
      throw new Error(
        "Sepolia chain not found in DB. Run pnpm db:seed-chains first."
      );
    }
    sepoliaRpcUrl = sepoliaChain[0].defaultPrimaryRpc;
    // Route on-chain reads (balance check, contract.retrieve()) through the
    // failover manager so a primary-RPC blip falls over to the secondary
    // instead of failing the test. The manager pulls primary + fallback
    // straight from the chains table -- same source the production runtime
    // uses for this chain.
    sepoliaManager = await getRpcProviderFromUrls(
      sepoliaRpcUrl,
      sepoliaChain[0].defaultFallbackRpc ?? undefined,
      SEPOLIA_CHAIN_ID,
      "sepolia"
    );

    // Look up persistent test org
    const testOrg = await db
      .select()
      .from(organization)
      .where(eq(organization.slug, TEST_ORG_SLUG))
      .limit(1);

    if (testOrg.length === 0) {
      throw new Error(
        `Test org "${TEST_ORG_SLUG}" not found. Run pnpm db:seed-test-wallet first.`
      );
    }
    orgId = testOrg[0].id;

    // Look up Para wallet
    const wallet = await db
      .select()
      .from(organizationWallets)
      .where(eq(organizationWallets.organizationId, orgId))
      .limit(1);

    if (wallet.length === 0) {
      throw new Error(
        "No Para wallet for test org. Run pnpm db:seed-test-wallet first."
      );
    }
    walletAddress = wallet[0].walletAddress;
    userId = wallet[0].userId;

    console.log(`Test org: ${orgId} (${TEST_ORG_SLUG})`);
    console.log(`Wallet:   ${walletAddress}`);

    // Verify the persistent wallet has sufficient gas
    const balance = await sepoliaManager.executeWithFailover((p) =>
      p.getBalance(walletAddress)
    );
    console.log(`Wallet balance: ${ethers.formatEther(balance)} ETH`);

    if (balance < MIN_BALANCE) {
      throw new Error(
        `Persistent test wallet has insufficient balance (${ethers.formatEther(balance)} ETH). ` +
          `Minimum required: ${ethers.formatEther(MIN_BALANCE)} ETH. ` +
          `Fund ${walletAddress} on Sepolia before running this test.`
      );
    }
  }, 120_000);

  afterAll(async () => {
    // Clean up test records in FK-safe order (keep org/wallet persistent)
    if (testExecutionId) {
      await db
        .delete(workflowExecutionLogs)
        .where(eq(workflowExecutionLogs.executionId, testExecutionId));
      await db
        .delete(workflowExecutions)
        .where(eq(workflowExecutions.id, testExecutionId));
    }
    if (testWorkflowId) {
      await db.delete(workflows).where(eq(workflows.id, testWorkflowId));
    }
    await client.end();
  });

  it("should execute write-contract step and verify on-chain state", async () => {
    // Dynamically import writeContractStep (it has "server-only" via wallet-helpers)
    const { writeContractStep } = await import(
      "@/plugins/web3/steps/write-contract"
    );

    // Pick a random value to store
    const randomValue = Date.now();

    // Seed a workflow for the test org
    testWorkflowId = generateId();
    await db.insert(workflows).values({
      id: testWorkflowId,
      name: "E2E Write Contract Test",
      userId,
      organizationId: orgId,
      nodes: [
        {
          id: "action-1",
          type: "action",
          data: {
            type: "write-contract",
            name: "Store Value",
            config: {
              contractAddress: SIMPLE_STORAGE_ADDRESS,
              network: String(SEPOLIA_CHAIN_ID),
              abi: SIMPLE_STORAGE_ABI,
              abiFunction: "store",
              functionArgs: JSON.stringify([randomValue]),
            },
          },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    });

    // Create execution record
    testExecutionId = generateId();
    await db.insert(workflowExecutions).values({
      id: testExecutionId,
      workflowId: testWorkflowId,
      userId,
      status: "running",
    });

    // Call writeContractStep directly
    const input: WriteContractInput = {
      contractAddress: SIMPLE_STORAGE_ADDRESS,
      network: String(SEPOLIA_CHAIN_ID),
      abi: SIMPLE_STORAGE_ABI,
      abiFunction: "store",
      functionArgs: JSON.stringify([randomValue]),
      _context: {
        executionId: testExecutionId,
        nodeId: "action-1",
        nodeName: "Store Value",
        nodeType: "write-contract",
      },
    };

    console.log(`Calling store(${randomValue}) on SimpleStorage...`);

    let result: Awaited<ReturnType<typeof writeContractStep>>;
    try {
      result = await writeContractStep(input);
    } catch (err: unknown) {
      // Para SDK beta environment can time out — skip rather than fail
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("timed out") || message.includes("timeout")) {
        console.warn(
          `Para SDK timed out (beta environment issue), skipping: ${message}`
        );
        return;
      }
      throw err;
    }

    console.log("writeContractStep result:", result);

    // The step may fail due to Para SDK timeout (returned as error, not thrown)
    if (!result.success) {
      const errorMsg = String(result.error ?? "");
      if (errorMsg.includes("timed out") || errorMsg.includes("timeout")) {
        console.warn(
          `Para SDK timed out (beta environment issue), skipping: ${errorMsg}`
        );
        return;
      }
      throw new Error(`Step failed: ${result.error}`);
    }

    // Assert step returned a tx hash
    expect(result.transactionHash).toMatch(TX_HASH_PATTERN);
    console.log(`Transaction hash: ${result.transactionHash}`);

    // Verify on-chain: call retrieve() and check the stored value. Construct
    // the Contract inside executeWithFailover so the read benefits from
    // failover the same way every other RPC call in this test does.
    const storedValue = await sepoliaManager.executeWithFailover((p) => {
      const contract = new ethers.Contract(
        SIMPLE_STORAGE_ADDRESS,
        JSON.parse(SIMPLE_STORAGE_ABI),
        p
      );
      return contract.retrieve();
    });
    console.log(`On-chain retrieve(): ${storedValue}`);
    expect(storedValue).toBe(BigInt(randomValue));
  }, 180_000); // 3 minute timeout for real tx
});
