import { SQS_QUEUE_URL } from "../../lib/config/environment";
import { createPhantomExecution } from "../../lib/phantom";
import { sqs } from "../../lib/sqs-client";
import { logger } from "../../lib/utils/logger";
import { enqueueWorkflowBlockTrigger } from "../../lib/workflow-sqs";
import { fetchSolanaTriggers } from "../../src/discovery";
import { buildRegistrations } from "../../src/mapper";
import { matchBlocks } from "../../src/match/block-matcher";
import type { NormalizedBlock } from "../../src/match/types";
import { executionStatus, poll } from "./lib";

/**
 * Injected-block E2E for the Block trigger (deterministic). Mirrors injected.ts
 * but drives the block path: discovery -> registration -> matchBlocks -> phantom
 * -> SQS -> executor, injecting a synthetic block whose height divides the
 * trigger's interval instead of polling a live chain. Proves the block
 * trigger's SQS -> executor -> execution leg with no devnet dependency.
 * Requires a live local stack (app-dev, localstack, redis, executor, Postgres).
 */
const WORKFLOW = process.env.E2E_WORKFLOW_ID ?? "dev_wf_block_on";
const CHAIN_ID = Number(process.env.E2E_CHAIN_ID ?? "103");

async function main(): Promise<void> {
  const data = await fetchSolanaTriggers();
  if (!data) {
    throw new Error("discovery returned no data (is app-dev up + HMAC set?)");
  }
  const reg = buildRegistrations(data).find((r) => r.chainId === CHAIN_ID);
  if (!reg) {
    throw new Error(`no chain ${CHAIN_ID} registration from discovery`);
  }
  const trigger = reg.blockTriggers.find((t) => t.workflowId === WORKFLOW);
  if (!trigger) {
    throw new Error(
      `${WORKFLOW} not found among chain ${CHAIN_ID} block triggers`,
    );
  }

  // A synthetic block whose height is divisible by the trigger interval, so the
  // real matcher fires. Block matching is height-based, so no transactions are
  // needed.
  const height = trigger.blockInterval * 1000;
  const block: NormalizedBlock = {
    slot: height + 1,
    blockHeight: height,
    blockhash: "e2e-injected-block",
    blockTime: Math.floor(Date.now() / 1000),
    parentSlot: height,
    transactions: [],
  };

  const fire = matchBlocks(block, reg.blockTriggers).find(
    (f) => f.workflowId === WORKFLOW,
  );
  if (!fire) {
    throw new Error("matcher produced no fire for the injected block");
  }

  const { executionId } = await createPhantomExecution(
    fire.workflowId,
    fire.userId,
    "block",
    "scheduler",
  );
  if (!executionId) {
    throw new Error("createPhantomExecution failed (check app-dev + HMAC)");
  }
  await enqueueWorkflowBlockTrigger(sqs, SQS_QUEUE_URL, {
    executionId,
    workflowId: fire.workflowId,
    userId: fire.userId,
    triggerData: fire.payload,
  });
  logger.log(
    `[e2e-injected-block] enqueued execution ${executionId}; waiting for the executor...`,
  );

  const advanced = await poll(
    () => executionStatus(executionId) !== "phantom",
    45_000,
  );
  const finalStatus = executionStatus(executionId);
  if (!advanced) {
    logger.error(
      `[e2e-injected-block] FAIL: execution ${executionId} stayed "phantom" - the executor did not consume the SQS message`,
    );
    process.exit(1);
  }
  logger.log(
    `[e2e-injected-block] PASS: injected block -> matcher -> phantom -> SQS -> executor (final status=${finalStatus})`,
  );
  process.exit(0);
}

main().catch((err) => {
  logger.error(
    `[e2e-injected-block] error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
