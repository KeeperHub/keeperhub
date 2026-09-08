/**
 * Protocol coverage: superfluid on the Ethereum mainnet fork.
 *
 * Gating and infra contract match the sibling lido coverage.test.ts.
 * Funding is whale impersonation (DAI) plus a setup wrap into DAIx; see
 * the chain-1 testData in protocols/superfluid.ts for why DAIx.
 */

import { afterAll, beforeAll, describe } from "vitest";
import { runPhaseFixtures } from "../../_shared/run-fixture";
import { cleanupAll, createSharedCtx, runSetup } from "../../_shared/setup";

const PROTOCOL = "superfluid";
const CHAIN_ID = "1";
const SKIP_INFRA_TESTS =
  !(process.env.DATABASE_URL && process.env.ANVIL_FORK_MAINNET_URL) ||
  process.env.SKIP_INFRA_TESTS === "true";

describe.skipIf(SKIP_INFRA_TESTS)(`${PROTOCOL} (Ethereum)`, () => {
  const ctx = createSharedCtx();

  beforeAll(async () => {
    await runSetup({ protocol: PROTOCOL, chainId: CHAIN_ID, ctx });
  }, 420_000);

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
