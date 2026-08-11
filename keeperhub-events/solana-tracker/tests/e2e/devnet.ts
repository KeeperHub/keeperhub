import { logger } from "../../lib/utils/logger";
import { shutdownAll, synchronizeData } from "../../src/main";
import { advancedCount, poll } from "./lib";

/**
 * Option 2 - live-devnet E2E (highest fidelity). Runs the real service flow:
 * discovery -> reconcile starts the devnet (chain 103) ingestor, which polls a
 * live Anchor program via RPC, matches events, and enqueues to SQS. Asserts the
 * executor completes a NEW execution (success count rises), then shuts down
 * immediately to bound the busy-program flood. Depends on live devnet + a
 * working RPC key, so it is on-demand only (never CI).
 */
const WORKFLOW = process.env.E2E_WORKFLOW_ID ?? "dev_wf_event_on";

async function main(): Promise<void> {
  const before = advancedCount(WORKFLOW);
  logger.log(`[e2e-devnet] baseline executed count for ${WORKFLOW}: ${before}`);

  await synchronizeData();
  logger.log(
    "[e2e-devnet] devnet ingestor started; watching for the executor to pick up a live event...",
  );

  const advanced = await poll(
    () => advancedCount(WORKFLOW) > before,
    60_000,
    1000,
  );
  const after = advancedCount(WORKFLOW);
  await shutdownAll();

  if (!advanced) {
    logger.error(
      `[e2e-devnet] FAIL: executor did not pick up a live devnet event within 60s (before=${before}, after=${after})`,
    );
    process.exit(1);
  }
  logger.log(
    `[e2e-devnet] PASS: live devnet event -> tracker -> SQS -> executor consumed it (before=${before}, after=${after})`,
  );
  process.exit(0);
}

main().catch((err) => {
  logger.error(
    `[e2e-devnet] error: ${err instanceof Error ? err.message : String(err)}`,
  );
  shutdownAll().finally(() => process.exit(1));
});
