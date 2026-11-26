import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBlockWorkflows } from "../../block-dispatcher/api-client.js";
import {
  parseBlockProgress,
  serializeBlockProgress,
} from "../../block-dispatcher/block-progress.js";
import { BlockMonitorService } from "../../block-dispatcher/monitor-service.js";
import { RECONCILE_INTERVAL_MS } from "../../lib/config.js";
import { metrics } from "../../lib/metrics.js";
import type { BlockWorkflow, ChainConfig } from "../../lib/types.js";

// ---------------------------------------------------------------------------
// Fake ChainMonitor: records the config each monitor was built with and lets
// a test flip liveness and progress the way a real monitor would report them.
// ---------------------------------------------------------------------------

const { FakeChainMonitor, monitors, startControl } = vi.hoisted(() => {
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
  // Number of upcoming start() calls that reject, as a failed connect would.
  const control = { failNextStarts: 0 };

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
      if (control.failNextStarts > 0) {
        control.failNextStarts -= 1;
        return Promise.reject(new Error("connect failed on both URLs"));
      }
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

  return {
    FakeChainMonitor: FakeMonitor,
    monitors: created,
    startControl: control,
  };
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
  vi.mocked(fetchBlockWorkflows).mockResolvedValue({
    platform: new Map([
      [chain.chainId, { chain, workflows: [makeWorkflow()] }],
    ]),
    routed: new Map(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BlockMonitorService reconcile", () => {
  let service: BlockMonitorService;

  beforeEach(() => {
    vi.useFakeTimers();
    monitors.length = 0;
    startControl.failNextStarts = 0;
    vi.mocked(fetchBlockWorkflows).mockReset();
    vi.spyOn(console, "log").mockImplementation((): void => {
      // suppress test output
    });
    vi.spyOn(console, "warn").mockImplementation((): void => {
      // suppress test output
    });
    vi.spyOn(console, "error").mockImplementation((): void => {
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

  it("keeps the resume block when the replacement monitor fails to start", async () => {
    serveChain(makeChain());
    await service.start();
    monitors[0].lastBlock = 1_000;
    monitors[0].alive = false;
    startControl.failNextStarts = 1;

    await nextReconcile();

    expect(monitors).toHaveLength(2);
    expect(monitors[1].config.resumeFromBlock).toBe(1_000);

    await nextReconcile();

    expect(monitors).toHaveLength(3);
    expect(monitors[2].config.resumeFromBlock).toBe(1_000);
  });

  it("reports the live monitor's last processed block as its resume block", async () => {
    serveChain(makeChain());
    await service.start();
    monitors[0].lastBlock = 2_500;

    expect(service.getResumeBlocks()).toEqual(new Map([[1, 2_500]]));
  });

  it("drops the resume block of a chain that no longer has workflows", async () => {
    serveChain(makeChain());
    await service.start(new Map([[1, 300]]));
    vi.mocked(fetchBlockWorkflows).mockResolvedValue({
      platform: new Map(),
      routed: new Map(),
    });

    await nextReconcile();

    expect(service.getResumeBlocks().size).toBe(0);
  });
});

describe("BlockMonitorService leader handoff", () => {
  const services: BlockMonitorService[] = [];

  function newService(): BlockMonitorService {
    const created = new BlockMonitorService();
    services.push(created);
    return created;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    monitors.length = 0;
    startControl.failNextStarts = 0;
    vi.mocked(fetchBlockWorkflows).mockReset();
    vi.spyOn(console, "log").mockImplementation((): void => {
      // suppress test output
    });
    vi.spyOn(console, "warn").mockImplementation((): void => {
      // suppress test output
    });
    vi.spyOn(console, "error").mockImplementation((): void => {
      // suppress test output
    });
  });

  afterEach(async () => {
    for (const created of services.splice(0)) {
      await created.stop();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    metrics.resetForTests();
  });

  it("resumes a new leader from the progress the old leader persisted", async () => {
    serveChain(makeChain());
    const oldLeader = newService();
    await oldLeader.start();
    monitors[0].lastBlock = 4_200;
    const persisted = serializeBlockProgress(oldLeader.getResumeBlocks());
    await oldLeader.stop();

    const newLeader = newService();
    await newLeader.start(parseBlockProgress(persisted));

    expect(monitors).toHaveLength(2);
    expect(monitors[1].config.resumeFromBlock).toBe(4_200);
  });

  it("keeps the persisted resume block when the first start fails", async () => {
    serveChain(makeChain());
    startControl.failNextStarts = 1;
    const leader = newService();

    await leader.start(new Map([[1, 4_200]]));
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);

    expect(monitors).toHaveLength(2);
    expect(monitors[0].config.resumeFromBlock).toBe(4_200);
    expect(monitors[1].config.resumeFromBlock).toBe(4_200);
  });

  it("starts monitors at the head when the persisted progress is unreadable", async () => {
    serveChain(makeChain());
    const leader = newService();

    await leader.start(parseBlockProgress("{not json"));

    expect(monitors).toHaveLength(1);
    expect(monitors[0].config.resumeFromBlock).toBeNull();
  });

  it("prefers the later block when this process already knows the chain", async () => {
    serveChain(makeChain());
    const leader = newService();
    await leader.start(new Map([[1, 100]]));
    monitors[0].lastBlock = 150;
    await leader.stop();

    await leader.start(new Map([[1, 120]]));

    expect(monitors[1].config.resumeFromBlock).toBe(150);
  });
});
