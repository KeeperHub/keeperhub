/**
 * Integration test verifying the reconciler detects a workflow config change and
 * restarts the listener with the new config. Without this behaviour, a
 * user editing their workflow would see the old config keep firing
 * forever - the regression that motivated the configHash comparison in
 * KEEP-295 Phase 4.
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
const TEST_QUEUE_NAME = "keeperhub-event-tracker-test-queue-config-change";
const WORKFLOW_ID = "test-workflow-keep-295-config-change";
const EMITTED_VALUE = 55n;

interface SqsBody {
  workflowId: string;
  userId: string;
  triggerType: string;
  triggerData: {
    eventName: string;
    args: Record<string, { value: string; type: string }>;
    transactionHash: string;
  };
}

function buildWorkflow(
  address: string,
  abi: unknown[],
  userId: string,
): unknown {
  return {
    id: WORKFLOW_ID,
    name: "Config Change",
    userId,
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
          description: "Config-change reconciler proof",
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

async function waitForUserId(
  sqsClient: SQSClient,
  queueUrl: string,
  expectedUserId: string,
  timeoutMs: number,
): Promise<Message | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await pollForMessage(sqsClient, queueUrl, 3_000);
    if (!msg) {
      continue;
    }
    const body = JSON.parse(msg.Body ?? "{}") as SqsBody;
    if (body.userId === expectedUserId) {
      return msg;
    }
  }
  return null;
}

describe.skipIf(SKIP_INFRA_TESTS)(
  "event-tracker: reconciler restarts on workflow config change",
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
      getConfigHash: (id: string) => string | undefined;
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
        workflows: [buildWorkflow(fixture.address, fixture.abi, "user-v1")],
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

    it("changing userId restarts the listener and the new config takes effect", async () => {
      // Initial sync: registry picks up userId v1.
      await synchronizeData();
      const registry = getRegistry();
      expect(registry.size()).toBe(1);
      const hashV1 = registry.getConfigHash(WORKFLOW_ID);
      expect(hashV1).toBeDefined();

      // Emit until we see a message tagged with the v1 userId.
      const emitEvent = fixture.contract.getFunction("emitEvent");
      let v1Msg: Message | null = null;
      for (let attempt = 0; attempt < 10 && !v1Msg; attempt++) {
        const tx = await emitEvent(EMITTED_VALUE);
        await tx.wait();
        v1Msg = await waitForUserId(sqsClient, queueUrl, "user-v1", 3_000);
      }
      expect(v1Msg).not.toBeNull();

      // Swap the mock API to a new userId. Same workflowId, same contract,
      // same event - only the user changed. configHash must change because
      // userId is in the hash input.
      mockApi.setResponse("/api/workflows/events", {
        workflows: [buildWorkflow(fixture.address, fixture.abi, "user-v2")],
        networks: buildNetworks(),
      });

      // Reconcile again. Reconciler should detect the hash mismatch, call
      // remove then add, and end up with a new hash for the same id.
      await synchronizeData();
      expect(registry.size()).toBe(1);
      expect(registry.has(WORKFLOW_ID)).toBe(true);
      const hashV2 = registry.getConfigHash(WORKFLOW_ID);
      expect(hashV2).toBeDefined();
      expect(hashV2).not.toBe(hashV1);

      // Emit again. The listener should now carry the v2 userId through
      // into the SQS body.
      let v2Msg: Message | null = null;
      for (let attempt = 0; attempt < 10 && !v2Msg; attempt++) {
        const tx = await emitEvent(EMITTED_VALUE);
        await tx.wait();
        v2Msg = await waitForUserId(sqsClient, queueUrl, "user-v2", 3_000);
      }
      expect(v2Msg).not.toBeNull();
      const body = JSON.parse(v2Msg?.Body ?? "{}") as SqsBody;
      expect(body.userId).toBe("user-v2");
      expect(body.workflowId).toBe(WORKFLOW_ID);
    }, 180_000);
  },
);
