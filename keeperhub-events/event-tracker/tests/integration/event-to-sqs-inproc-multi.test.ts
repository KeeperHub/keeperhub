/**
 * Integration test verifying two in-process listeners on the same chain + contract +
 * event share one WebSocketProvider and one block subscription, and both
 * receive the same on-chain log via the demux path - the central
 * invariant of the Phase 1-4 refactor.
 *
 * Asserts, in addition to end-to-end delivery:
 *   - `providerManager.hasProvider(chainId)` is true (provider was created)
 *   - `providerManager.subscriberCount(chainId) === 2` (both listeners
 *     multiplex through one ChainEntry, not two separate providers)
 *
 * Without those structural assertions the test would pass equally well if
 * each listener created its own provider, silently defeating the refactor.
 *
 * Requires the `test` docker-compose profile. Skipped when
 * SKIP_INFRA_TESTS=true.
 */

import type { Message, SQSClient } from "@aws-sdk/client-sqs";
import type { ethers } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getAnvilChainId,
  getAnvilRpcUrl,
  getAnvilWallet,
  getAnvilWssUrl,
  waitForAnvil,
} from "./helpers/anvil-helpers";
import {
  type DeployedFixture,
  deployEventEmitter,
} from "./helpers/fixture-contract";
import { type MockApiServer, startMockApi } from "./helpers/mock-api";
import {
  createQueue,
  deleteQueue,
  makeSqsClient,
  pollForMessage,
  purgeQueue,
} from "./helpers/sqs-helpers";

const SKIP_INFRA_TESTS = process.env.SKIP_INFRA_TESTS === "true";
const AWS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4567";
const REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6380);
const TEST_QUEUE_NAME = "keeperhub-event-tracker-test-queue-multi";
const WORKFLOW_A = "test-workflow-keep-295-multi-a";
const WORKFLOW_B = "test-workflow-keep-295-multi-b";
const EMITTED_VALUE = 77n;

interface SqsBody {
  workflowId: string;
  triggerType: string;
  triggerData: {
    eventName: string;
    args: Record<string, { value: string; type: string }>;
    transactionHash: string;
  };
}

function buildWorkflow(id: string, address: string, abi: unknown[]): unknown {
  return {
    id,
    name: `Multi ${id}`,
    userId: "test-user",
    organizationId: "test-org",
    enabled: true,
    nodes: [
      {
        id: "node-1",
        type: "trigger",
        selected: false,
        data: {
          type: "event-trigger",
          label: "Emitted",
          status: "active",
          description: "Multi-listener shared-provider proof",
          config: {
            network: String(getAnvilChainId()),
            eventName: "Emitted",
            contractABI: JSON.stringify(abi),
            triggerType: "event",
            contractAddress: address,
          },
        },
      },
    ],
  };
}

function buildNetworks(): Record<number, unknown> {
  const now = new Date().toISOString();
  return {
    [getAnvilChainId()]: {
      id: `local-${getAnvilChainId()}`,
      chainId: getAnvilChainId(),
      name: "Anvil",
      symbol: "ETH",
      chainType: "evm",
      defaultPrimaryRpc: getAnvilRpcUrl(),
      defaultFallbackRpc: getAnvilRpcUrl(),
      defaultPrimaryWss: getAnvilWssUrl(),
      defaultFallbackWss: getAnvilWssUrl(),
      isTestnet: true,
      isEnabled: true,
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe.skipIf(SKIP_INFRA_TESTS)(
  "event-tracker: two workflows on the same chain share one provider",
  () => {
    let fixture: DeployedFixture;
    let wallet: ethers.Wallet;
    let mockApi: MockApiServer;
    let sqsClient: SQSClient;
    let queueUrl: string;
    let synchronizeData: () => Promise<void>;
    let getRegistry: () => {
      size: () => number;
      has: (id: string) => boolean;
      ids: () => string[];
      stopAll: () => Promise<void>;
    };
    let providerManager: {
      hasProvider: (chainId: number) => boolean;
      subscriberCount: (chainId: number) => number;
    };

    beforeAll(async () => {
      await waitForAnvil();
      wallet = getAnvilWallet();
      fixture = await deployEventEmitter(wallet);

      sqsClient = makeSqsClient(AWS_ENDPOINT);
      queueUrl = await createQueue(sqsClient, TEST_QUEUE_NAME, AWS_ENDPOINT);
      await purgeQueue(sqsClient, queueUrl);

      mockApi = await startMockApi();
      mockApi.setResponse("/api/workflows/events", {
        workflows: [
          buildWorkflow(WORKFLOW_A, fixture.address, fixture.abi),
          buildWorkflow(WORKFLOW_B, fixture.address, fixture.abi),
        ],
        networks: buildNetworks(),
      });

      process.env.KEEPERHUB_API_URL = mockApi.url;
      process.env.SQS_QUEUE_URL = queueUrl;
      process.env.AWS_ENDPOINT_URL = AWS_ENDPOINT;
      process.env.AWS_REGION = "us-east-1";
      process.env.AWS_ACCESS_KEY_ID = "test";
      process.env.AWS_SECRET_ACCESS_KEY = "test";
      process.env.REDIS_HOST = REDIS_HOST;
      process.env.REDIS_PORT = String(REDIS_PORT);
      process.env.NODE_ENV = "test";

      const mainMod = await import("../../src/main");
      synchronizeData = mainMod.synchronizeData;
      getRegistry = mainMod.getRegistry;
      const pmMod = await import("../../src/chains/provider-manager");
      providerManager = pmMod.chainProviderManager;
    }, 120_000);

    afterAll(async () => {
      try {
        if (getRegistry) {
          await getRegistry().stopAll();
        }
      } catch {
        // ignore
      }
      await mockApi?.close();
      await deleteQueue(sqsClient, queueUrl);
    }, 30_000);

    it("both listeners receive the same on-chain event and forward to SQS", async () => {
      await synchronizeData();

      // Registry should hold both workflows.
      const registry = getRegistry();
      expect(registry.size()).toBe(2);
      expect(registry.has(WORKFLOW_A)).toBe(true);
      expect(registry.has(WORKFLOW_B)).toBe(true);

      // Shared-provider invariant: both listeners share one provider and
      // one block subscription, not two separate WebSocketProviders.
      const chainId = getAnvilChainId();
      expect(
        providerManager.hasProvider(chainId),
        "ChainProviderManager should have created exactly one provider for the test chain",
      ).toBe(true);
      expect(
        providerManager.subscriberCount(chainId),
        "both listeners should multiplex through one ChainEntry (subscriberCount === 2)",
      ).toBe(2);

      // Emit in a retry loop until both messages arrive.
      const emitEvent = fixture.contract.getFunction("emitEvent");
      const seen = new Map<string, Message>();
      const MAX_ATTEMPTS = 10;
      const PER_ATTEMPT_MS = 3_000;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (seen.size === 2) {
          break;
        }
        const tx = await emitEvent(EMITTED_VALUE);
        await tx.wait();
        while (seen.size < 2) {
          const msg = await pollForMessage(sqsClient, queueUrl, PER_ATTEMPT_MS);
          if (!msg) {
            break;
          }
          const body = JSON.parse(msg.Body ?? "{}") as SqsBody;
          if (!seen.has(body.workflowId)) {
            seen.set(body.workflowId, msg);
          }
        }
      }

      expect(
        seen.size,
        `expected both workflows to deliver; got ${[...seen.keys()].join(", ") || "none"}`,
      ).toBe(2);
      expect(seen.has(WORKFLOW_A)).toBe(true);
      expect(seen.has(WORKFLOW_B)).toBe(true);

      for (const [wfId, msg] of seen) {
        const body = JSON.parse(msg.Body ?? "{}") as SqsBody;
        expect(body.workflowId).toBe(wfId);
        expect(body.triggerType).toBe("event");
        expect(body.triggerData.eventName).toBe("Emitted");
        expect(body.triggerData.args.value.value).toBe(String(EMITTED_VALUE));
      }
    }, 120_000);
  },
);
