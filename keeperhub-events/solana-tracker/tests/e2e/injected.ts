import { SQS_QUEUE_URL } from "../../lib/config/environment";
import { createPhantomExecution } from "../../lib/phantom";
import { sqs } from "../../lib/sqs-client";
import { logger } from "../../lib/utils/logger";
import { enqueueWorkflowEventTrigger } from "../../lib/workflow-sqs";
import { createEventDecoder } from "../../src/decode/solana-idl";
import { fetchSolanaTriggers } from "../../src/discovery";
import { buildRegistrations } from "../../src/mapper";
import { matchEvents } from "../../src/match/event-matcher";
import type { NormalizedBlock } from "../../src/match/types";
import { executionStatus, poll } from "./lib";

/**
 * Option 1 - injected-block E2E (deterministic). Reuses the real discovery ->
 * registration -> matcher -> phantom -> SQS path, but injects a synthetic block
 * (one tx invoking the watched program) instead of polling a live chain, then
 * asserts the executor consumed the message (the execution advances past
 * "phantom"). Proves the SQS -> executor -> execution leg without any devnet
 * dependency. Requires a live local stack + env (see scripts/e2e/README notes).
 */
const WORKFLOW = process.env.E2E_WORKFLOW_ID ?? "dev_wf_event_on";
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
  const trigger = reg.eventTriggers.find((t) => t.workflowId === WORKFLOW);
  if (!trigger) {
    throw new Error(
      `${WORKFLOW} not found among chain ${CHAIN_ID} event triggers`,
    );
  }

  // One tx invoking exactly the program this workflow watches, so the real
  // matcher fires for it.
  const program = trigger.programId;
  const block: NormalizedBlock = {
    slot: 999_999_999,
    blockHeight: null,
    blockhash: "e2e-injected",
    blockTime: null,
    parentSlot: 0,
    transactions: [
      {
        signature: `e2e-injected-${Date.now()}`,
        programIds: [program],
        logMessages: [`Program ${program} invoke [1]`, "Program log: e2e"],
        failed: false,
      },
    ],
  };

  const decoders = new Map([
    [trigger.workflowId, createEventDecoder(trigger.idl, trigger.workflowId)],
  ]);
  const fires = matchEvents(block, reg.eventTriggers, decoders, reg.commitment);
  if (fires.length === 0) {
    throw new Error("matcher produced no fire for the injected block");
  }

  const fire = fires[0];
  const { executionId } = await createPhantomExecution(
    fire.workflowId,
    fire.userId,
    "event",
    "events",
  );
  if (!executionId) {
    throw new Error("createPhantomExecution failed (check app-dev + HMAC)");
  }
  await enqueueWorkflowEventTrigger(sqs, SQS_QUEUE_URL, {
    executionId,
    workflowId: fire.workflowId,
    userId: fire.userId,
    triggerData: fire.payload,
  });
  logger.log(
    `[e2e-injected] enqueued execution ${executionId}; waiting for the executor...`,
  );

  const advanced = await poll(
    () => executionStatus(executionId) !== "phantom",
    45_000,
  );
  const finalStatus = executionStatus(executionId);
  if (!advanced) {
    logger.error(
      `[e2e-injected] FAIL: execution ${executionId} stayed "phantom" - the executor did not consume the SQS message`,
    );
    process.exit(1);
  }
  logger.log(
    `[e2e-injected] PASS: injected block -> matcher -> phantom -> SQS -> executor (final status=${finalStatus})`,
  );
  process.exit(0);
}

main().catch((err) => {
  logger.error(
    `[e2e-injected] error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
