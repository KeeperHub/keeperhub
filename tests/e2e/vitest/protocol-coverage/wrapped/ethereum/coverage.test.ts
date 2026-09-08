/**
 * Protocol coverage: wrapped (WETH) on Ethereum mainnet fork.
 *
 * Requires a running anvil mainnet fork on port 8548 (test-anvil-fork-mainnet
 * service in docker-compose.yml). The fork-mode funding path uses
 * anvil_setBalance for native gas — no TESTNET_FUNDER_PK needed.
 */

import { afterAll, beforeAll, describe } from "vitest";
import { runPhaseFixtures } from "../../_shared/run-fixture";
import { cleanupAll, createSharedCtx, runSetup } from "../../_shared/setup";

const PROTOCOL = "wrapped";
const CHAIN_ID = "1";
// Requires a live anvil mainnet fork. Skip cleanly when the fork is absent
// so PR / staging-push CI stays green (fork spinup is gated by secret availability).
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
