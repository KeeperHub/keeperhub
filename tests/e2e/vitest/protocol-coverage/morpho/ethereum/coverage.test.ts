/**
 * Protocol coverage: Morpho Blue on Ethereum mainnet fork.
 *
 * Requires a running anvil mainnet fork on port 8548 (test-anvil-fork-mainnet
 * service in docker-compose.yml). The fork-mode funding path uses whale
 * impersonation for WSTETH and USDC — no TESTNET_FUNDER_PK needed.
 *
 * Write actions run in dependency order: accrue-interest and set-authorization
 * first (no prerequisites), then supply-collateral, supply, borrow, repay,
 * withdraw, withdraw-collateral.
 */

import { afterAll, beforeAll, describe } from "vitest";
import { runPhaseFixtures } from "../../_shared/run-fixture";
import { cleanupAll, createSharedCtx, runSetup } from "../../_shared/setup";

const PROTOCOL = "morpho";
const CHAIN_ID = "1";
// morpho has the registry's longest setup write chain (two token
// provisions, three approvals, vault interactions), so it only fits the
// shard budget against a warmed, pinned fork cache (PROTOCOL_FORK_CACHED,
// so reads are served locally). The sibling chain-1 suites tolerate a cold
// fork and gate on ANVIL_FORK_MAINNET_URL alone.
const SKIP_INFRA_TESTS =
  !(
    process.env.DATABASE_URL &&
    process.env.ANVIL_FORK_MAINNET_URL &&
    process.env.PROTOCOL_FORK_CACHED
  ) || process.env.SKIP_INFRA_TESTS === "true";

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
