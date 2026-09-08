import { afterAll, beforeAll, describe } from "vitest";
import { runPhaseFixtures } from "../../_shared/run-fixture";
import { cleanupAll, createSharedCtx, runSetup } from "../../_shared/setup";

const PROTOCOL = "pendle";
const CHAIN_ID = "1";
const SKIP_INFRA_TESTS =
  !(process.env.DATABASE_URL && process.env.ANVIL_FORK_MAINNET_URL) ||
  process.env.SKIP_INFRA_TESTS === "true";

describe.skipIf(SKIP_INFRA_TESTS)(`${PROTOCOL} (Ethereum)`, () => {
  const ctx = createSharedCtx();

  // Above the 600s testData setup.executionWaitMs: the setup runs three
  // real approvals through the app (SY, PT, YT -> router), and each has
  // been observed to take 100-220s on a cold fork under shared-wallet
  // contention.
  beforeAll(async () => {
    await runSetup({ protocol: PROTOCOL, chainId: CHAIN_ID, ctx });
  }, 900_000);

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
