/**
 * Integration test for the in-process listener architecture.
 *
 * Emits an event on a local chain and asserts the corresponding SQS message
 * is dispatched. Also asserts the registry holds the workflow after sync.
 *
 * Requires the `test` docker-compose profile (test-anvil, test-localstack,
 * test-redis). Skipped when SKIP_INFRA_TESTS=true.
 */

import type { SQSClient } from "@aws-sdk/client-sqs";
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
const TEST_QUEUE_NAME = "keeperhub-event-tracker-test-queue-inproc";
const WORKFLOW_ID = "test-workflow-keep-295-inproc";
const EMITTED_VALUE = 42n;

interface TypedValue {
  value: string;
  type: string;
}
interface TriggerData {
  eventName: string;
  args: Record<string, TypedValue>;
  address: string;
  transactionHash: string;
}
interface SqsBody {
  workflowId: string;
  triggerType: string;
  triggerData: TriggerData;
}

function buildWorkflow(address: string, abi: unknown[]): unknown {
  return {
    id: WORKFLOW_ID,
    name: "Phase 4 In-Process",
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
          description: "In-process listener path",
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
  "event-tracker: on-chain event -> SQS (in-process architecture)",
  () => {
    let fixture: DeployedFixture;
    let wallet: ethers.Wallet;
    let mockApi: MockApiServer;
    let sqsClient: SQSClient;
    let queueUrl: string;
    // main.ts is imported dynamically after env is set so that env-captured
    // module-level state (dedup client in listener/dedup-redis) picks up the
    // test values.
    let synchronizeData: () => Promise<void>;
    let getRegistry: () => {
      size: () => number;
      has: (id: string) => boolean;
      ids: () => string[];
      stopAll: () => Promise<void>;
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
        workflows: [buildWorkflow(fixture.address, fixture.abi)],
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
        // Stop any registered in-process listeners so their provider-manager
        // subscriptions close cleanly.
        if (getRegistry) {
          await getRegistry().stopAll();
        }
      } catch {
        // ignore
      }
      await mockApi?.close();
      await deleteQueue(sqsClient, queueUrl);
    }, 30_000);

    it("forwards an emitted contract event to SQS via the in-process listener", async () => {
      await synchronizeData();

      // Prove the in-process path was taken: the registry should hold
      // exactly the one workflow we registered through the mock API.
      const registry = getRegistry();
      expect(registry.size()).toBe(1);
      expect(registry.has(WORKFLOW_ID)).toBe(true);

      const emitEvent = fixture.contract.getFunction("emitEvent");
      let received: Awaited<ReturnType<typeof pollForMessage>> = null;
      const MAX_ATTEMPTS = 10;
      const PER_ATTEMPT_MS = 3_000;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const tx = await emitEvent(EMITTED_VALUE);
        await tx.wait();
        received = await pollForMessage(sqsClient, queueUrl, PER_ATTEMPT_MS);
        if (received) {
          break;
        }
      }

      expect(
        received,
        `no SQS message received after ${MAX_ATTEMPTS} emits; in-process listener likely never attached`,
      ).not.toBeNull();

      const body = JSON.parse(received?.Body ?? "{}") as SqsBody;
      expect(body.workflowId).toBe(WORKFLOW_ID);
      expect(body.triggerType).toBe("event");
      expect(body.triggerData.eventName).toBe("Emitted");
      expect(body.triggerData.address.toLowerCase()).toBe(
        fixture.address.toLowerCase(),
      );
      expect(body.triggerData.args.value.type).toBe("uint256");
      expect(body.triggerData.args.value.value).toBe(String(EMITTED_VALUE));
      expect(body.triggerData.args.sender.type).toBe("address");
      expect(body.triggerData.args.sender.value.toLowerCase()).toBe(
        wallet.address.toLowerCase(),
      );
    }, 90_000);
  },
);
