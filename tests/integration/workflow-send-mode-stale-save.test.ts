// An editor does not read saved nodes back, so it keeps sending the Send as keys
// it opened with. Saves of a stored key conflict must leave it as stored, or the
// next save sees only the flag as changed and flips the mode.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const store = vi.hoisted(() => ({
  nodes: [] as unknown[],
  writes: 0,
}));

const schema = vi.hoisted(() => ({
  workflows: { id: "id", name: "name", userId: "user_id" },
  chains: {
    chainId: "chain_id",
    usePrivateMempoolRpc: "use_private_mempool_rpc",
    defaultPrivateRpcUrl: "default_private_rpc_url",
  },
  workflowPublicTags: { workflowId: "workflow_id" },
  publicTags: { id: "id" },
  member: { id: "id", organizationId: "organization_id", userId: "user_id" },
  users: { id: "id" },
  projects: { id: "id" },
  tags: { id: "id" },
  workflowExecutions: { workflowId: "workflow_id" },
  workflowSchedules: { workflowId: "workflow_id" },
}));

function storedRow(): Record<string, unknown> {
  return {
    id: "wf-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "wf",
    description: "",
    nodes: structuredClone(store.nodes),
    edges: [],
    visibility: "private",
    isAnonymous: false,
    enabled: false,
    projectId: null,
    tagId: null,
    isListed: false,
    listedSlug: null,
    listedAt: null,
    inputSchema: null,
    outputMapping: null,
    priceUsdcPerCall: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

// One chain with a relay; workflows, members and the rest answer with stored rows.
function fromTable(table: unknown): Record<string, unknown> {
  const rows =
    table === schema.chains
      ? [
          {
            chainId: 1,
            usePrivateMempoolRpc: true,
            defaultPrivateRpcUrl: "https://relay.example",
          },
        ]
      : [];
  const limited = table === schema.workflows ? [storedRow()] : [{ id: "m-1" }];
  const query = {
    innerJoin: () => query,
    where: () =>
      Object.assign(Promise.resolve(rows), {
        limit: () => Promise.resolve(limited),
      }),
  };
  return query;
}

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflows: { findFirst: vi.fn(() => Promise.resolve(storedRow())) },
    },
    select: vi.fn(() => ({ from: fromTable })),
    update: vi.fn(() => ({
      set: vi.fn((data: { nodes?: unknown[] }) => {
        if (data.nodes) {
          store.nodes = structuredClone(data.nodes);
          store.writes += 1;
        }
        return {
          where: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([storedRow()])),
          })),
        };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  },
}));

vi.mock("@/lib/db/schema", () => schema);

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn().mockResolvedValue({
    userId: "user-1",
    organizationId: "org-1",
    authMethod: "session",
  }),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
    },
  },
}));

vi.mock("@/lib/middleware/org-context", () => ({
  getOrgContext: vi.fn().mockResolvedValue({ organization: { id: "org-1" } }),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/db/integrations", () => ({
  validateWorkflowIntegrations: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock("@/lib/features/route-guard", () => ({
  enforceWorkflowFeatures: vi.fn().mockResolvedValue({ blocked: false }),
  FEATURE_UPGRADE_REQUIRED_ERROR:
    "This workflow uses features that require a paid plan.",
}));

vi.mock("@/lib/schedule-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/schedule-service")>(
    "@/lib/schedule-service"
  );
  return {
    ...actual,
    syncPersistedWorkflowSchedule: vi.fn().mockResolvedValue({ synced: true }),
  };
});

vi.mock("@/lib/sanitize-description", () => ({
  sanitizeDescription: vi.fn((raw: string) => raw),
}));

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));

import { PATCH } from "@/app/api/workflows/[workflowId]/route";
import { POST as saveDraft } from "@/app/api/workflows/current/route";

function writeNode(
  keys: Record<string, unknown>,
  abiFunction = "run"
): Record<string, unknown> {
  return {
    id: "w-1",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: "Write",
      config: {
        actionType: "web3/write-contract",
        network: "1",
        contractAddress: "0x000000000000000000000000000000000000dEaD",
        abi: `[{"type":"function","name":"${abiFunction}","inputs":[],"outputs":[],"stateMutability":"nonpayable"}]`,
        abiFunction,
        ...keys,
      },
    },
  };
}

type Save = (node: Record<string, unknown>) => Promise<Response>;

const routes: [string, Save][] = [
  [
    "PATCH /api/workflows/[workflowId]",
    (node) =>
      PATCH(
        new Request("http://localhost:3000/api/workflows/wf-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nodes: [node] }),
        }),
        { params: Promise.resolve({ workflowId: "wf-1" }) }
      ),
  ],
  [
    "POST /api/workflows/current",
    (node) =>
      saveDraft(
        new Request("http://localhost:3000/api/workflows/current", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nodes: [node], edges: [] }),
        })
      ),
  ],
];

function storedKeys(): Record<string, unknown> {
  const config = (
    store.nodes[0] as { data: { config: Record<string, unknown> } }
  ).data.config;
  return {
    sendMode: config.sendMode,
    usePrivateMempool: config.usePrivateMempool,
  };
}

describe.each(routes)("%s with Send as keys", (_name, save) => {
  beforeEach(() => {
    store.writes = 0;
  });

  it.each([
    { sendMode: "private-relay", usePrivateMempool: false },
    { sendMode: "transaction", usePrivateMempool: true },
  ])(
    "keeps a stored conflict %j as stored over two saves from an editor still holding it",
    async (conflict) => {
      store.nodes = [writeNode(conflict)];
      // Another field edited twice; the editor still sends the keys it opened with.
      for (const abiFunction of ["first", "second"]) {
        const response = await save(writeNode(conflict, abiFunction));
        expect(response.status).toBe(200);
        expect(storedKeys()).toEqual(conflict);
      }
      expect(store.writes).toBe(2);
    }
  );

  it("still lets a flag-only change from an API client win when the keys agreed", async () => {
    store.nodes = [
      writeNode({ sendMode: "private-relay", usePrivateMempool: true }),
    ];
    const off = await save(
      writeNode({ sendMode: "private-relay", usePrivateMempool: false })
    );
    expect(off.status).toBe(200);
    expect(storedKeys()).toEqual({
      sendMode: "transaction",
      usePrivateMempool: false,
    });

    const on = await save(
      writeNode({ sendMode: "transaction", usePrivateMempool: true })
    );
    expect(on.status).toBe(200);
    expect(storedKeys()).toEqual({
      sendMode: "private-relay",
      usePrivateMempool: true,
    });
  });

  it("fills a missing flag, and a stale client sending sendMode alone keeps it", async () => {
    store.nodes = [
      writeNode({ sendMode: "transaction", usePrivateMempool: false }),
    ];
    for (const label of ["first save", "second save"]) {
      const response = await save(writeNode({ sendMode: "private-relay" }));
      expect(response.status, label).toBe(200);
      expect(storedKeys(), label).toEqual({
        sendMode: "private-relay",
        usePrivateMempool: true,
      });
    }
  });
});
