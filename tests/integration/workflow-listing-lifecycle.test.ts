/**
 * Integration test for the workflow listing lifecycle (list -> unlist -> relist).
 *
 * Tests lib/mcp/listing.ts state machine helpers directly with an in-memory
 * Drizzle mock. Cross-org 404 behaviour is covered in
 * tests/unit/mcp-curator-tools.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type WorkflowRow = {
  id: string;
  organizationId: string;
  isListed: boolean;
  listedSlug: string | null;
  listedAt: Date | null;
  priceUsdcPerCall: string | null;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  category: string | null;
  chain: string | null;
  workflowType: "read" | "write";
  visibility: "private" | "unlisted" | "public";
  shareExecutionStatus: boolean;
  nodes: unknown[];
  createdAt: Date;
  updatedAt: Date;
};

let workflowState: WorkflowRow;

vi.mock("@/lib/db", () => ({
  db: {
    select: (cols?: unknown) => {
      // getWorkflowListing / getWorkflowListingPublic both pass a column map
      // (each includes listedSlug) and are public reads — must honour the
      // isListed=true filter. Other selects (e.g. updateWorkflowListing's
      // pre-flight by id+orgId) use db.select() with no columns and ignore the
      // listing invariant.
      const isColumnSelect =
        cols !== undefined && cols !== null && typeof cols === "object";
      const isPublicListingRead =
        isColumnSelect && "listedSlug" in (cols as Record<string, unknown>);
      return {
        from: (_table: unknown) => ({
          where: (_condition: unknown) => ({
            limit: (_n: number) => {
              if (isPublicListingRead && !workflowState.isListed) {
                return Promise.resolve([]);
              }
              if (isColumnSelect) {
                // Mirror Drizzle column projection: only the selected columns
                // are returned. This makes getWorkflowListingPublic's
                // PUBLIC_LISTING_COLUMNS (which omits `nodes`) observable in the
                // result, while getWorkflowListing's LISTING_COLUMNS keeps them.
                const projected: Record<string, unknown> = {};
                for (const key of Object.keys(
                  cols as Record<string, unknown>
                )) {
                  projected[key] = (workflowState as Record<string, unknown>)[
                    key
                  ];
                }
                return Promise.resolve([projected]);
              }
              return Promise.resolve([workflowState]);
            },
          }),
        }),
      };
    },
    update: (_table: unknown) => ({
      set: (data: Partial<WorkflowRow>) => ({
        where: (_condition: unknown) => ({
          returning: () => {
            Object.assign(workflowState, data);
            return Promise.resolve([workflowState]);
          },
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: {
    id: "id",
    organizationId: "organizationId",
    isListed: "isListed",
    listedSlug: "listedSlug",
    listedAt: "listedAt",
    name: "name",
    description: "description",
    inputSchema: "inputSchema",
    outputMapping: "outputMapping",
    priceUsdcPerCall: "priceUsdcPerCall",
    category: "category",
    chain: "chain",
    workflowType: "workflowType",
    nodes: "nodes",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
}));

const {
  listWorkflow,
  unlistWorkflow,
  getWorkflowListing,
  getWorkflowListingPublic,
  updateWorkflowListing,
} = await import("@/lib/mcp/listing");

const WORKFLOW_ID = "wf-test-001";
const ORG_ID = "org-test-001";

describe("workflow listing lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowState = {
      id: WORKFLOW_ID,
      organizationId: ORG_ID,
      isListed: false,
      listedSlug: null,
      listedAt: null,
      priceUsdcPerCall: null,
      name: "Test Workflow",
      description: null,
      // Listed workflows must declare an inputSchema (enforced by listWorkflow).
      // An empty object is fine for zero-input workflows.
      inputSchema: { type: "object" },
      outputMapping: null,
      category: null,
      chain: null,
      workflowType: "read",
      // Listing does not change visibility; a workflow stays private until the
      // separate go-live flow promotes it.
      visibility: "private",
      shareExecutionStatus: false,
      nodes: [],
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };
  });

  it("list: sets isListed=true, assigns listedSlug, sets listedAt", async () => {
    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "my-test-workflow",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.listing.isListed).toBe(true);
    expect(result.listing.listedSlug).toBe("my-test-workflow");
    expect(result.listing.listedAt).toBeInstanceOf(Date);
  });

  it("list without a slug on a never-listed workflow returns SLUG_REQUIRED (consistent with the workflows PATCH route)", async () => {
    // A listed workflow must carry a slug — external agents invoke it by slug
    // at /api/mcp/workflows/<slug>/call. listedSlug starts null here, so listing
    // with no slug must be refused rather than create a discoverable-but-
    // uncallable row. The PATCH backdoor route enforces the same SLUG_REQUIRED.
    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBe("SLUG_REQUIRED");
  });

  it("list with a whitespace-only slug returns SLUG_REQUIRED (matches the PATCH route's trim check)", async () => {
    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, { slug: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBe("SLUG_REQUIRED");
  });

  it("list trims a padded slug before persisting it", async () => {
    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "  padded-slug  ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.listing.listedSlug).toBe("padded-slug");
  });

  it("list: rejects shareExecutionStatus on a private workflow", async () => {
    // Listing is not publishing. Without this the curator gets a 200, the flag
    // persists, and every /executions/<id> link 404s because the read gate
    // keys off visibility.
    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "share-on-private",
      shareExecutionStatus: true,
    });

    expect(result).toEqual({
      ok: false,
      error: "SHARE_REQUIRES_PUBLIC_VISIBILITY",
    });
    expect(workflowState.shareExecutionStatus).toBe(false);
  });

  it("list: accepts shareExecutionStatus on an unlisted-visibility workflow", async () => {
    workflowState.visibility = "unlisted";

    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "share-on-unlisted",
      shareExecutionStatus: true,
    });

    expect(result.ok).toBe(true);
    expect(workflowState.shareExecutionStatus).toBe(true);
  });

  it("list: always accepts turning sharing off, whatever the visibility", async () => {
    workflowState.shareExecutionStatus = true;

    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "share-off-on-private",
      shareExecutionStatus: false,
    });

    expect(result.ok).toBe(true);
    expect(workflowState.shareExecutionStatus).toBe(false);
  });

  it("unlist: sets isListed=false, preserves listedSlug and listedAt", async () => {
    await listWorkflow(WORKFLOW_ID, ORG_ID, { slug: "my-test-workflow" });
    const listingTimestamp = workflowState.listedAt;

    const result = await unlistWorkflow(WORKFLOW_ID, ORG_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.listing.isListed).toBe(false);
    expect(result.listing.listedSlug).toBe("my-test-workflow");
    expect(result.listing.listedAt?.getTime()).toBe(
      listingTimestamp?.getTime()
    );
  });

  it("getWorkflowListing: returns NOT_FOUND for unlisted workflow even when listedSlug is preserved (sticky-slug)", async () => {
    // Public read invariant: an unlisted workflow MUST NOT leak metadata via the
    // public GET endpoint, even though unlistWorkflow intentionally preserves
    // listedSlug for relist. Without the isListed=true filter this query
    // returned the unlisted row, exposing price/schemas/orgId publicly.
    await listWorkflow(WORKFLOW_ID, ORG_ID, { slug: "leak-test" });
    expect(workflowState.listedSlug).toBe("leak-test");

    const listedRead = await getWorkflowListing("leak-test");
    expect(listedRead.ok).toBe(true);

    await unlistWorkflow(WORKFLOW_ID, ORG_ID);
    expect(workflowState.isListed).toBe(false);
    expect(workflowState.listedSlug).toBe("leak-test");

    const unlistedRead = await getWorkflowListing("leak-test");
    expect(unlistedRead.ok).toBe(false);
    if (unlistedRead.ok) {
      return;
    }
    expect(unlistedRead.error).toBe("NOT_FOUND");
  });

  it("list: rejects workflowType='write' when no node has a write actionType", async () => {
    workflowState.nodes = [
      {
        id: "read-1",
        data: {
          actionType: "web3/read-contract",
          config: { contractAddress: "0xabc" },
        },
      },
    ];

    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "broken-write",
      workflowType: "write",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBe("MISSING_WRITE_ACTION");
    expect(workflowState.isListed).toBe(false);
  });

  it("list: succeeds when workflowType='write' and a web3/write-contract node exists", async () => {
    workflowState.nodes = [
      {
        id: "write-1",
        data: {
          actionType: "web3/write-contract",
          config: {
            contractAddress: "0xabc",
            network: "16602",
            abi: "[]",
            abiFunction: "transfer",
          },
        },
      },
    ];

    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "good-write",
      workflowType: "write",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.listing.isListed).toBe(true);
    expect(result.listing.workflowType).toBe("write");
  });

  it("update on a LISTED write workflow with no write node returns MISSING_WRITE_ACTION", async () => {
    // Listed write workflow whose nodes were swapped out for read-only after
    // listing -- updateWorkflowListing must catch the broken state.
    workflowState.isListed = true;
    workflowState.listedSlug = "live-write";
    workflowState.workflowType = "write";
    workflowState.nodes = [
      {
        id: "read-1",
        data: {
          actionType: "web3/read-contract",
          config: { contractAddress: "0xabc" },
        },
      },
    ];

    const result = await updateWorkflowListing(WORKFLOW_ID, ORG_ID, {
      category: "test",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBe("MISSING_WRITE_ACTION");
  });

  it("update on an UNLISTED draft skips the MISSING_WRITE_ACTION guard", async () => {
    // Drafts can be saved with workflow_type=write while still under construction.
    // The guard only fires on listed rows.
    workflowState.isListed = false;
    workflowState.workflowType = "write";
    workflowState.nodes = [];

    const result = await updateWorkflowListing(WORKFLOW_ID, ORG_ID, {
      category: "test",
    });

    expect(result.ok).toBe(true);
  });

  it("list: rejects INPUT_SCHEMA_REQUIRED when neither row nor metadata declares inputSchema", async () => {
    workflowState.inputSchema = null;

    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "no-schema",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBe("INPUT_SCHEMA_REQUIRED");
    expect(workflowState.isListed).toBe(false);
  });

  it("list: accepts inputSchema supplied via metadata even when row is null", async () => {
    workflowState.inputSchema = null;

    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "schema-via-metadata",
      inputSchema: { type: "object" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.listing.isListed).toBe(true);
    expect(result.listing.inputSchema).toEqual({ type: "object" });
  });

  it("list: rejects INVALID_TEMPLATE_LITERALS when a node config has a bare @-literal", async () => {
    workflowState.nodes = [
      {
        id: "read-1",
        type: "action",
        data: {
          label: "Trapped autocomplete",
          type: "action",
          config: {
            actionType: "web3/read-contract",
            address: "@40",
            backup: 'fallback: "@trigger-2"',
          },
        },
      },
    ];

    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "trapped-autocomplete",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBe("INVALID_TEMPLATE_LITERALS");
    // details.literals surfaces the offending tokens so the route can return
    // them in the 422 body for debuggability.
    expect(result.details?.literals).toEqual(
      expect.arrayContaining(["@40", "@trigger-2"])
    );
    expect(workflowState.isListed).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────
  // updateWorkflowListing defense-in-depth: refuses to apply curator metadata
  // changes if the listed workflow's nodes/schema were corrupted out-of-band.
  // ──────────────────────────────────────────────────────────────────────

  it("updateWorkflowListing: rejects INVALID_TEMPLATE_LITERALS when listed workflow has bare-@ in nodes", async () => {
    // Out-of-band corruption: a script or admin tool persisted bad nodes
    // bypassing the workflows-PATCH gate. The curator PATCH must refuse to
    // re-emphasize the broken listing via metadata changes.
    workflowState.isListed = true;
    workflowState.listedSlug = "live-wf";
    workflowState.listedAt = new Date();
    workflowState.nodes = [
      {
        id: "read-1",
        type: "action",
        data: {
          type: "action",
          config: { actionType: "web3/read-contract", address: "@40" },
        },
      },
    ];

    const result = await updateWorkflowListing(WORKFLOW_ID, ORG_ID, {
      category: "defi",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBe("INVALID_TEMPLATE_LITERALS");
    expect(result.details?.literals).toContain("@40");
  });

  it("updateWorkflowListing: rejects INPUT_SCHEMA_REQUIRED when listed workflow has null inputSchema", async () => {
    workflowState.isListed = true;
    workflowState.listedSlug = "live-wf";
    workflowState.listedAt = new Date();
    workflowState.inputSchema = null;

    const result = await updateWorkflowListing(WORKFLOW_ID, ORG_ID, {
      category: "defi",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBe("INPUT_SCHEMA_REQUIRED");
  });

  it("updateWorkflowListing: accepts schema supplied via patch even when row is null", async () => {
    workflowState.isListed = true;
    workflowState.listedSlug = "live-wf";
    workflowState.listedAt = new Date();
    workflowState.inputSchema = null;

    const result = await updateWorkflowListing(WORKFLOW_ID, ORG_ID, {
      inputSchema: { type: "object" },
    });

    expect(result.ok).toBe(true);
  });

  it("updateWorkflowListing: skips defense-in-depth gates on unlisted draft", async () => {
    // Drafts can be in any state — only listed rows trigger the validators.
    workflowState.isListed = false;
    workflowState.inputSchema = null;
    workflowState.nodes = [
      {
        id: "read-1",
        type: "action",
        data: {
          type: "action",
          config: { actionType: "web3/read-contract", address: "@40" },
        },
      },
    ];

    const result = await updateWorkflowListing(WORKFLOW_ID, ORG_ID, {
      category: "defi",
    });

    expect(result.ok).toBe(true);
  });

  it("relist: preserves listedSlug, refreshes listedAt, isListed=true", async () => {
    await listWorkflow(WORKFLOW_ID, ORG_ID, { slug: "my-test-workflow" });
    const firstListedAt = workflowState.listedAt as Date;

    await unlistWorkflow(WORKFLOW_ID, ORG_ID);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2);
    });

    // Relist without passing slug — existing listedSlug should be preserved
    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.listing.isListed).toBe(true);
    expect(result.listing.listedSlug).toBe("my-test-workflow");
    expect(result.listing.listedAt).toBeInstanceOf(Date);
    expect((result.listing.listedAt as Date).getTime()).toBeGreaterThan(
      firstListedAt.getTime()
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // workflowType is auto-derived from content: a callable write node forces
  // "write" and overrides a conflicting "read". Detection matches the calldata
  // generator, so value transfers/approvals do not qualify.
  // ──────────────────────────────────────────────────────────────────────

  const WRITE_CONTRACT_NODE = {
    id: "write-1",
    data: {
      actionType: "web3/write-contract",
      config: {
        contractAddress: "0xabc",
        network: "11155111",
        abi: "[]",
        abiFunction: "transfer",
      },
    },
  };

  it("list: auto-flips workflowType to 'write' when a write node exists and no type was supplied", async () => {
    workflowState.workflowType = "read";
    workflowState.nodes = [WRITE_CONTRACT_NODE];

    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "auto-write",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.listing.workflowType).toBe("write");
  });

  it("list: overrides a conflicting 'read' to 'write' when content has a write node", async () => {
    workflowState.workflowType = "read";
    workflowState.nodes = [WRITE_CONTRACT_NODE];

    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "conflicting-read",
      workflowType: "read",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.listing.workflowType).toBe("write");
  });

  it("update: auto-flips an unlisted draft to 'write' when a write node exists", async () => {
    workflowState.isListed = false;
    workflowState.workflowType = "read";
    workflowState.nodes = [WRITE_CONTRACT_NODE];

    const result = await updateWorkflowListing(WORKFLOW_ID, ORG_ID, {
      category: "defi",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.listing.workflowType).toBe("write");
  });

  it("list: does NOT classify a transfer-token node as 'write' (not calldata-generatable)", async () => {
    workflowState.workflowType = "read";
    workflowState.nodes = [
      {
        id: "transfer-1",
        data: {
          actionType: "web3/transfer-token",
          config: { network: "11155111" },
        },
      },
    ];

    const result = await listWorkflow(WORKFLOW_ID, ORG_ID, {
      slug: "transfer-only",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.listing.workflowType).toBe("read");
  });

  // ──────────────────────────────────────────────────────────────────────
  // Public projection: the unauthenticated GET path must never return workflow
  // nodes (contract addresses, webhook URLs, calldata). The authenticated
  // per-workflow MCP server still needs the full nodes-bearing row.
  // ──────────────────────────────────────────────────────────────────────

  it("getWorkflowListingPublic: omits `nodes` but keeps listing metadata; getWorkflowListing still returns nodes", async () => {
    const SENTINEL_CONTRACT = "0xSENTINELdeadbeefCONTRACT";
    const SENTINEL_WEBHOOK = "https://internal.example/secret-webhook";
    workflowState.isListed = true;
    workflowState.listedSlug = "public-projection";
    workflowState.priceUsdcPerCall = "0.50";
    workflowState.inputSchema = {
      type: "object",
      properties: { amount: { type: "string" } },
    };
    workflowState.outputMapping = { txHash: "result.hash" };
    workflowState.nodes = [
      {
        id: "write-1",
        data: {
          actionType: "web3/write-contract",
          config: {
            contractAddress: SENTINEL_CONTRACT,
            webhookUrl: SENTINEL_WEBHOOK,
          },
        },
      },
    ];

    const publicRead = await getWorkflowListingPublic("public-projection");
    expect(publicRead.ok).toBe(true);
    if (!publicRead.ok) {
      return;
    }
    // Node internals must never reach unauthenticated callers.
    expect("nodes" in publicRead.listing).toBe(false);
    const serialized = JSON.stringify(publicRead.listing);
    expect(serialized).not.toContain(SENTINEL_CONTRACT);
    expect(serialized).not.toContain(SENTINEL_WEBHOOK);
    // Bazaar-facing metadata is still projected.
    expect(publicRead.listing.inputSchema).toEqual({
      type: "object",
      properties: { amount: { type: "string" } },
    });
    expect(publicRead.listing.outputMapping).toEqual({ txHash: "result.hash" });
    expect(publicRead.listing.listedSlug).toBe("public-projection");
    expect(publicRead.listing.priceUsdcPerCall).toBe("0.50");

    // Companion: the authenticated per-workflow MCP server path still gets the
    // nodes it needs for trigger detection.
    const fullRead = await getWorkflowListing("public-projection");
    expect(fullRead.ok).toBe(true);
    if (!fullRead.ok) {
      return;
    }
    expect(fullRead.listing.nodes).toHaveLength(1);
    expect(JSON.stringify(fullRead.listing.nodes)).toContain(SENTINEL_CONTRACT);
  });
});
