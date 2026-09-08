import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowNode } from "@/lib/workflow/store";
import { WorkflowTriggerEnum } from "@/lib/workflow/store";

// The discovery endpoints run in a Next.js server context; vitest is plain Node.
vi.mock("server-only", () => ({}));

// Accept every request - these tests cover the chainType filter, not auth.
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: () => ({
    authenticated: true,
    service: "events" as const,
  }),
}));

type Row = Record<string, unknown>;

// Mutable per-test row holders the mocked db serves back. Hoisted so the
// vi.mock factory (itself hoisted above the imports) can close over them.
const rows = vi.hoisted(() => ({
  workflows: [] as Row[],
  chains: [] as Row[],
}));

// Minimal drizzle-shaped stub. The chainType filter is pure JS over the rows
// each route selects, so the query builder only needs to return the seeded
// rows: `.from(workflows)` is always consumed via `.where(...)`, while
// `.from(chains)` is awaited directly in the events route and via `.where(...)`
// in the block route - hence a promise that also carries a `.where`.
vi.mock("@/lib/db", async () => {
  const schema =
    await vi.importActual<typeof import("@/lib/db/schema")>("@/lib/db/schema");
  const withWhere = (data: Row[]): { where: () => Promise<Row[]> } => ({
    where: () => Promise.resolve(data),
  });
  const promiseWithWhere = (
    data: Row[]
  ): Promise<Row[]> & { where: () => Promise<Row[]> } => {
    const p = Promise.resolve(data) as Promise<Row[]> & {
      where: () => Promise<Row[]>;
    };
    p.where = () => Promise.resolve(data);
    return p;
  };
  return {
    db: {
      select: () => ({
        from: (table: unknown) =>
          table === schema.chains
            ? promiseWithWhere(rows.chains)
            : withWhere(rows.workflows),
      }),
    },
  };
});

const { GET: eventsGET } = await import("@/app/api/workflows/events/route");
const { GET: blockGET } = await import(
  "@/app/api/internal/block-workflows/route"
);

const CHAINS: Row[] = [
  { chainId: 1, chainType: "evm", name: "Ethereum" },
  { chainId: 8453, chainType: "evm", name: "Base" },
  { chainId: 101, chainType: "solana", name: "Solana Mainnet" },
  { chainId: 103, chainType: "solana", name: "Solana Devnet" },
];

function triggerNode(config: Record<string, unknown>): WorkflowNode {
  return {
    id: "trigger-1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: { label: "Trigger", type: "trigger", config },
  };
}

function workflowRow(id: string, config: Record<string, unknown>): Row {
  return {
    id,
    name: id,
    userId: "user-1",
    organizationId: "org-1",
    enabled: true,
    nodes: [triggerNode(config)],
  };
}

function get(
  handler: (request: Request) => Promise<Response>,
  chainType?: string
): Promise<Response> {
  const suffix = chainType ? `&chainType=${chainType}` : "";
  return handler(
    new Request(`http://localhost/api/discovery?active=true${suffix}`, {
      method: "GET",
    })
  );
}

async function workflowIds(response: Response): Promise<string[]> {
  const body = (await response.json()) as { workflows: { id: string }[] };
  return body.workflows.map((w) => w.id).sort();
}

beforeEach(() => {
  rows.chains = [...CHAINS];
});

describe("event discovery chainType filter", () => {
  beforeEach(() => {
    rows.workflows = [
      workflowRow("evm-event", {
        triggerType: WorkflowTriggerEnum.EVENT,
        network: "1",
        contractAddress: "0xabc",
      }),
      workflowRow("solana-event", {
        triggerType: WorkflowTriggerEnum.EVENT,
        network: "101",
        programId: "So11111111111111111111111111111111111111112",
      }),
      workflowRow("networkless-event", {
        triggerType: WorkflowTriggerEnum.EVENT,
        contractAddress: "0xdef",
      }),
    ];
  });

  it("default (no chainType) returns EVM + network-less, never Solana", async () => {
    expect(await workflowIds(await get(eventsGET))).toEqual([
      "evm-event",
      "networkless-event",
    ]);
  });

  it("chainType=evm behaves identically to the default", async () => {
    expect(await workflowIds(await get(eventsGET, "evm"))).toEqual([
      "evm-event",
      "networkless-event",
    ]);
  });

  it("chainType=solana returns only Solana-network workflows", async () => {
    expect(await workflowIds(await get(eventsGET, "solana"))).toEqual([
      "solana-event",
    ]);
  });

  it("leaves the networks map unfiltered (all chains) regardless of chainType", async () => {
    const body = (await (await get(eventsGET, "solana")).json()) as {
      networks: Record<string, unknown>;
    };
    expect(Object.keys(body.networks).sort()).toEqual([
      "1",
      "101",
      "103",
      "8453",
    ]);
  });
});

describe("block discovery chainType filter", () => {
  beforeEach(() => {
    rows.workflows = [
      workflowRow("evm-block", {
        triggerType: WorkflowTriggerEnum.BLOCK,
        network: "8453",
        blockInterval: 1,
      }),
      workflowRow("solana-block", {
        triggerType: WorkflowTriggerEnum.BLOCK,
        network: "103",
        blockInterval: 1,
      }),
      workflowRow("networkless-block", {
        triggerType: WorkflowTriggerEnum.BLOCK,
        blockInterval: 1,
      }),
    ];
  });

  it("default (no chainType) returns EVM + network-less, never Solana", async () => {
    expect(await workflowIds(await get(blockGET))).toEqual([
      "evm-block",
      "networkless-block",
    ]);
  });

  it("chainType=solana returns only Solana-network workflows", async () => {
    expect(await workflowIds(await get(blockGET, "solana"))).toEqual([
      "solana-block",
    ]);
  });
});
