import { describe, expect, it } from "vitest";
import {
  runGasComposed,
  runGasDisplay,
} from "@/components/analytics/runs-table";
import type { UnifiedRun } from "@/lib/analytics/types";
import { createChainDisplay } from "@/lib/hooks/use-chain-display";

const BASE = "8453"; // ETH
const POLYGON = "137"; // POL
const AVALANCHE = "43114"; // AVAX, outside the sponsorship table

const ONE_TENTH = "100000000000000000"; // 0.1e18

function run(overrides: Partial<UnifiedRun>): UnifiedRun {
  return {
    id: "run",
    source: "workflow",
    status: "success",
    startedAt: new Date(0).toISOString(),
    completedAt: null,
    durationMs: null,
    workflowId: "wf",
    workflowName: "wf",
    directType: null,
    network: null,
    networks: [],
    gasNetworks: [],
    gasCostWei: null,
    transactionHashes: [],
    gasUsedWei: null,
    totalSteps: null,
    completedSteps: null,
    error: null,
    errorCode: null,
    errorType: null,
    errorCategory: null,
    ...overrides,
  };
}

describe("runGasDisplay", () => {
  it("shows the amount for a run that wrote on one chain and read on another", () => {
    // The case the targeted-chains reading got wrong: two chains touched, gas
    // on one, so the total is summable and must not collapse to "Composed".
    expect(
      runGasDisplay(
        run({
          networks: [BASE, POLYGON],
          gasNetworks: [BASE],
          gasUsedWei: ONE_TENTH,
          network: BASE,
        })
      )
    ).toBe("0.10 ETH");
  });

  it("denominates in the chain the gas landed on, not an arbitrary targeted one", () => {
    // networks[0] is Base here; keying the symbol off it would print ETH
    // against an amount that was actually spent in POL.
    expect(
      runGasDisplay(
        run({
          networks: [BASE, POLYGON],
          gasNetworks: [POLYGON],
          gasUsedWei: ONE_TENTH,
          network: POLYGON,
        })
      )
    ).toBe("0.10 POL");
  });

  it("composes a run that genuinely spent on two chains", () => {
    expect(
      runGasComposed(
        run({
          networks: [BASE, POLYGON],
          gasNetworks: [BASE, POLYGON],
          gasUsedWei: ONE_TENTH,
          network: BASE,
        })
      )
    ).toBe(true);
  });

  it("composes ledger-only gas that cannot be attributed to one chain", () => {
    // No step rollup names a chain, and the run touched two, so there is no
    // token to render the sponsored amount in.
    expect(
      runGasComposed(
        run({
          networks: [BASE, POLYGON],
          gasNetworks: [],
          gasCostWei: ONE_TENTH,
          network: BASE,
        })
      )
    ).toBe(true);
  });

  it("does not compose a run whose gas landed on one chain", () => {
    expect(
      runGasComposed(
        run({
          networks: [BASE, POLYGON],
          gasNetworks: [BASE],
          gasUsedWei: ONE_TENTH,
          network: BASE,
        })
      )
    ).toBe(false);
  });

  it("borrows the run's chain for ledger-only gas on a single-chain run", () => {
    expect(
      runGasDisplay(
        run({
          networks: [POLYGON],
          gasNetworks: [],
          gasCostWei: ONE_TENTH,
          network: POLYGON,
        })
      )
    ).toBe("0.10 POL");
  });

  it("renders no amount for a read-only run that touched several chains", () => {
    // The bug this guards: reading three targeted chains as a multi-chain
    // spend labelled every read-only cross-chain run "Composed".
    const readOnly = run({
      networks: [BASE, POLYGON, AVALANCHE],
      gasNetworks: [],
      network: BASE,
    });
    expect(runGasComposed(readOnly)).toBe(false);
    expect(runGasDisplay(readOnly)).toBe("-");
  });

  it("renders no amount for a run that failed before broadcast", () => {
    expect(
      runGasDisplay(
        run({
          status: "error",
          networks: [BASE],
          gasNetworks: [],
          network: BASE,
        })
      )
    ).toBe("-");
  });

  it("denominates a run on a chain the sponsorship table does not cover", () => {
    // Without the chain registry the amount would read as ETH.
    const chains = createChainDisplay([
      { chainId: 43_114, name: "Avalanche", symbol: "AVAX" },
    ]);
    expect(
      runGasDisplay(
        run({
          networks: [AVALANCHE],
          gasNetworks: [AVALANCHE],
          gasUsedWei: ONE_TENTH,
          network: AVALANCHE,
        }),
        chains
      )
    ).toBe("0.10 AVAX");
  });
});
