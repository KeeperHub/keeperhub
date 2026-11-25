import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBlockWorkflows } from "../../block-dispatcher/api-client.js";
import { BlockMonitorService } from "../../block-dispatcher/monitor-service.js";
import { RECONCILE_INTERVAL_MS } from "../../lib/config.js";
import { metrics } from "../../lib/metrics.js";
import type { BlockWorkflow, ChainConfig } from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Fake ChainMonitor: records the config each monitor was built with and lets
// a test flip liveness and progress the way a real monitor would report them.
// ---------------------------------------------------------------------------

const { FakeChainMonitor, monitors } = vi.hoisted(() => {
  type Config = {
    chain: {
      chainId: number;
      name: string;
      defaultPrimaryWss: string | null;
      defaultFallbackWss: string | null;
    };
    workflows: unknown[];
    resumeFromBlock?: number | null;
  };

  const created: FakeMonitor[] = [];

  class FakeMonitor {
    alive = true;
    stopped = false;
    lastBlock: number | null = null;
    workflows: unknown[];

    constructor(readonly config: Config) {
      this.workflows = config.workflows;
      created.push(this);
    }

    start(): Promise<void> {
      return Promise.resolve();
    }

    stop(): Promise<void> {
      this.stopped = true;
      return Promise.resolve();
    }

    isAlive(): boolean {
      return this.alive;
    }

    hasConfigChanged(chain: Config["chain"]): boolean {
      return (
        chain.defaultPrimaryWss !== this.config.chain.defaultPrimaryWss ||
        chain.defaultFallbackWss !== this.config.chain.defaultFallbackWss
      );
    }

    updateWorkflows(workflows: unknown[]): void {
      this.workflows = workflows;
    }

    getStatus(): {
      chainId: number;
      chainName: string;
      alive: boolean;
      reconnecting: boolean;
      hasSubscription: boolean;
      lastBlock: number | null;
      blocksReceived: number;
      blocksMatched: number;
      workflows: number;
    } {
      return {
        chainId: this.config.chain.chainId,
        chainName: this.config.chain.name,
        alive: this.alive,
        reconnecting: false,
        hasSubscription: true,
        lastBlock: this.lastBlock,
        blocksReceived: 0,
        blocksMatched: 0,
        workflows: this.workflows.length,
      };
    }
  }

  return { FakeChainMonitor: FakeMonitor, monitors: created };
});

vi.mock("../../block-dispatcher/chain-monitor.js", () => ({
  ChainMonitor: FakeChainMonitor,
}));

vi.mock("../../block-dispatcher/api-client.js", () => ({
  fetchBlockWorkflows: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChain(overrides?: Partial<ChainConfig>): ChainConfig {
  return {
    chainId: 1,
    name: "Ethereum Mainnet",
    defaultPrimaryWss: "wss://primary.test",
    defaultFallbackWss: "wss://fallback.test",
    ...overrides,
  };
}

function makeWorkflow(): BlockWorkflow {
  return {
    id: "wf-1",
    name: "Test Workflow",
    userId: "user-1",
    organizationId: null,
    network: "1",
    blockInterval: 1,
  };
}

function serveChain(chain: ChainConfig): void {
  vi.mocked(fetchBlockWorkflows).mockResolvedValue(
    new Map([[chain.chainId, { chain, workflows: [makeWorkflow()] }]]),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BlockMonitorService reconcile", () => {
  let service: BlockMonitorService;

  beforeEach(() => {
    vi.useFakeTimers();
    monitors.length = 0;
    vi.mocked(fetchBlockWorkflows).mockReset();
    vi.spyOn(console, "log").mockImplementation((): void => {
      // suppress test output
    });
    vi.spyOn(console, "warn").mockImplementation((): void => {
      // suppress test output
    });
    service = new BlockMonitorService();
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    metrics.resetForTests();
  });

  async function nextReconcile(): Promise<void> {
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
  }

  it("starts a monitor for a new chain without a resume block", async () => {
    serveChain(makeChain());

    await service.start();

    expect(monitors).toHaveLength(1);
    expect(monitors[0].config.resumeFromBlock).toBeNull();
  });

  it("recreates a dead monitor and resumes after its last processed block", async () => {
    serveChain(makeChain());
    await service.start();
    monitors[0].lastBlock = 26_489_481;
    monitors[0].alive = false;

    await nextReconcile();

    expect(monitors).toHaveLength(2);
    expect(monitors[0].stopped).toBe(true);
    expect(monitors[1].config.resumeFromBlock).toBe(26_489_481);
  });

  it("resumes with no block when the dead monitor never processed one", async () => {
    serveChain(makeChain());
    await service.start();
    monitors[0].alive = false;

    await nextReconcile();

    expect(monitors).toHaveLength(2);
    expect(monitors[1].config.resumeFromBlock).toBeNull();
  });

  it("carries the last processed block over when the WSS config changes", async () => {
    serveChain(makeChain());
    await service.start();
    monitors[0].lastBlock = 500;

    serveChain(makeChain({ defaultPrimaryWss: "wss://new-primary.test" }));
    await nextReconcile();

    expect(monitors).toHaveLength(2);
    expect(monitors[0].stopped).toBe(true);
    expect(monitors[1].config.chain.defaultPrimaryWss).toBe(
      "wss://new-primary.test",
    );
    expect(monitors[1].config.resumeFromBlock).toBe(500);
  });

  it("keeps a live monitor with unchanged config", async () => {
    serveChain(makeChain());
    await service.start();
    monitors[0].lastBlock = 500;

    await nextReconcile();

    expect(monitors).toHaveLength(1);
    expect(monitors[0].stopped).toBe(false);
  });
});
