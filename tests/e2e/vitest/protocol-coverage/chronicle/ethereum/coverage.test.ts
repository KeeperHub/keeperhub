/**
 * Protocol coverage: chronicle on the Ethereum mainnet fork.
 *
 * Gating and infra contract match the sibling lido coverage.test.ts.
 * Mainnet Scribe feeds are toll-gated with no SelfKisser, so the setup
 * preflight whitelists the test wallet via testData
 * forkImpersonatedCalls (an authed ward kisses the wallet - anvil
 * impersonation, fork only). Chronicle also tolls address(0) on
 * mainnet, so from-less eth_call reads pass regardless; the kiss keeps
 * the wallet itself whitelisted for from-bearing calls.
 */

import { afterAll, beforeAll, describe } from "vitest";
import { runPhaseFixtures } from "../../_shared/run-fixture";
import { cleanupAll, createSharedCtx, runSetup } from "../../_shared/setup";

const PROTOCOL = "chronicle";
const CHAIN_ID = "1";
const SKIP_INFRA_TESTS =
  !(process.env.DATABASE_URL && process.env.ANVIL_FORK_MAINNET_URL) ||
  process.env.SKIP_INFRA_TESTS === "true";

describe.skipIf(SKIP_INFRA_TESTS)(`${PROTOCOL} (Ethereum)`, () => {
  const ctx = createSharedCtx();

  beforeAll(async () => {
    await runSetup({ protocol: PROTOCOL, chainId: CHAIN_ID, ctx });
  }, 600_000);

  afterAll(async () => {
    await cleanupAll(ctx);
  });

  describe("read", () => {
    runPhaseFixtures({
      protocol: PROTOCOL,
      chainId: CHAIN_ID,
      phase: "read",
      ctx,
    });
  });

  describe("write", () => {
    runPhaseFixtures({
      protocol: PROTOCOL,
      chainId: CHAIN_ID,
      phase: "write",
      ctx,
    });
  });
});
