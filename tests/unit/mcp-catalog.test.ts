import { beforeEach, describe, expect, it, vi } from "vitest";

const SANITIZED_PREFIX_RE = /^SANITIZED:/;

// -- hoisted mocks --
const {
  mockDbSelect,
  mockSelectColumns,
  mockWhere,
  mockOrderBy,
  mockLimit,
  mockOffset,
  mockCountWhere,
} = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockSelectColumns: vi.fn(),
  mockWhere: vi.fn(),
  mockOrderBy: vi.fn(),
  mockLimit: vi.fn(),
  mockOffset: vi.fn(),
  mockCountWhere: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: mockDbSelect,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflows: {
    id: "id",
    name: "name",
    description: "description",
    listedSlug: "listed_slug",
    listedAt: "listed_at",
    inputSchema: "input_schema",
    outputMapping: "output_mapping",
    priceUsdcPerCall: "price_usdc_per_call",
    organizationId: "organization_id",
    createdAt: "created_at",
    updatedAt: "updated_at",
    isListed: "is_listed",
    isAnonymous: "is_anonymous",
    featured: "featured",
    featuredOrder: "featured_order",
    featuredProtocol: "featured_protocol",
    featuredProtocolOrder: "featured_protocol_order",
    projectId: "project_id",
    tagId: "tag_id",
    visibility: "visibility",
    enabled: "enabled",
    workflowType: "workflow_type",
    category: "category",
    chain: "chain",
    deletedAt: "deleted_at",
  },
}));

vi.mock("@/lib/sanitize-description", () => ({
  sanitizeDescription: vi.fn((raw: string) => `SANITIZED:${raw}`),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ type: "eq", col, val })),
  ilike: vi.fn((col: unknown, pattern: unknown) => ({
    type: "ilike",
    col,
    pattern,
  })),
  isNull: vi.fn((col: unknown) => ({ type: "isNull", col })),
  or: vi.fn((...args: unknown[]) => ({ type: "or", args })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
  desc: vi.fn((col: unknown) => ({ type: "desc", col })),
  count: vi.fn((col?: unknown) => ({ type: "count", col })),
  sql: vi.fn(),
}));

// Import after mocks
import { GET } from "@/app/api/mcp/workflows/route";

function makeRequest(url: string): Request {
  return new Request(url);
}

const LISTED_WORKFLOW = {
  id: "wf-1",
  name: "My Workflow",
  description: "Does things",
  listedSlug: "my-workflow",
  listedAt: new Date("2026-01-01"),
  inputSchema: null,
  outputMapping: null,
  priceUsdcPerCall: null,
  organizationId: "org-1",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  isListed: true,
  workflowType: "read" as const,
  category: null as string | null,
  chain: null as string | null,
};

const ANOTHER_LISTED_WORKFLOW = {
  ...LISTED_WORKFLOW,
  id: "wf-2",
  name: "Another Workflow",
  description: "Also does things",
  listedSlug: "another-workflow",
};

function setupDbMocks(
  countValue: number,
  dataRows: (typeof LISTED_WORKFLOW)[]
): void {
  vi.clearAllMocks();

  // Count query chain: db.select({ count }) -> from() -> where() -> [{ count: N }]
  const countChain = {
    from: vi.fn(() => ({ where: mockCountWhere })),
  };
  mockCountWhere.mockResolvedValue([{ count: countValue }]);

  // Data query chain: db.select(cols) -> from() -> where() -> orderBy() -> limit() -> offset() -> rows
  mockWhere.mockReturnValue({ orderBy: mockOrderBy });
  mockOrderBy.mockReturnValue({ limit: mockLimit });
  mockLimit.mockReturnValue({ offset: mockOffset });
  mockOffset.mockResolvedValue(dataRows);

  const dataChain = {
    from: vi.fn(() => ({ where: mockWhere })),
  };

  // Route calls Promise.all([countQuery, dataQuery]) so select is called twice.
  // First call = count query, second call = data query.
  mockDbSelect.mockImplementation((cols: unknown) => {
    mockSelectColumns(cols);
    const isCountQuery =
      cols !== null &&
      typeof cols === "object" &&
      "count" in (cols as Record<string, unknown>);
    return isCountQuery ? countChain : dataChain;
  });
}

describe("GET /api/mcp/workflows", () => {
  beforeEach(() => {
    setupDbMocks(2, [LISTED_WORKFLOW, ANOTHER_LISTED_WORKFLOW]);
  });

  it("returns only isListed=true workflows (where clause filters by isListed)", async () => {
    const { eq } = await import("drizzle-orm");
    const req = makeRequest("http://localhost:3000/api/mcp/workflows");

    const res = await GET(req);
    expect(res.status).toBe(200);

    // eq should have been called with isListed = true
    expect(eq).toHaveBeenCalledWith("is_listed", true);
  });

  it("response objects never contain nodes, edges, or userId keys", async () => {
    const req = makeRequest("http://localhost:3000/api/mcp/workflows");
    const res = await GET(req);
    const body = (await res.json()) as { items: Record<string, unknown>[] };

    for (const item of body.items) {
      expect(item).not.toHaveProperty("nodes");
      expect(item).not.toHaveProperty("edges");
      expect(item).not.toHaveProperty("userId");
    }
  });

  it("select columns object does not include nodes, edges, or userId", async () => {
    const req = makeRequest("http://localhost:3000/api/mcp/workflows");
    await GET(req);

    // Find the data-query call (non-count columns object)
    const calls = mockSelectColumns.mock.calls;
    const dataQueryCall = calls.find((call) => {
      const cols = call[0] as Record<string, unknown> | undefined;
      return cols !== undefined && !("count" in cols);
    });
    expect(dataQueryCall).toBeDefined();
    const cols = dataQueryCall?.[0] as Record<string, unknown> | undefined;
    expect(cols).not.toHaveProperty("nodes");
    expect(cols).not.toHaveProperty("edges");
    expect(cols).not.toHaveProperty("userId");
  });

  it("?q=term adds ilike filter on name, description, and listedSlug", async () => {
    const { ilike, or } = await import("drizzle-orm");
    const req = makeRequest(
      "http://localhost:3000/api/mcp/workflows?q=transfer"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    expect(ilike).toHaveBeenCalledWith("name", "%transfer%");
    expect(ilike).toHaveBeenCalledWith("description", "%transfer%");
    expect(ilike).toHaveBeenCalledWith("listed_slug", "%transfer%");
    expect(or).toHaveBeenCalled();
  });

  it("?q= with no match returns empty items, total 0, page 1, limit 20", async () => {
    setupDbMocks(0, []);

    const req = makeRequest(
      "http://localhost:3000/api/mcp/workflows?q=nomatch"
    );
    const res = await GET(req);
    const body = (await res.json()) as {
      items: unknown[];
      total: number;
      page: number;
      limit: number;
    };

    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
  });

  it("default pagination is page=1, limit=20", async () => {
    const req = makeRequest("http://localhost:3000/api/mcp/workflows");
    const res = await GET(req);
    const body = (await res.json()) as { page: number; limit: number };

    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
    expect(mockLimit).toHaveBeenCalledWith(20);
    expect(mockOffset).toHaveBeenCalledWith(0); // (1-1)*20 = 0
  });

  it("custom ?page=2&limit=10 offsets correctly (offset=10)", async () => {
    setupDbMocks(15, [LISTED_WORKFLOW]);

    const req = makeRequest(
      "http://localhost:3000/api/mcp/workflows?page=2&limit=10"
    );
    const res = await GET(req);
    const body = (await res.json()) as { page: number; limit: number };

    expect(body.page).toBe(2);
    expect(body.limit).toBe(10);
    expect(mockLimit).toHaveBeenCalledWith(10);
    expect(mockOffset).toHaveBeenCalledWith(10); // (2-1)*10 = 10
  });

  it("descriptions are sanitized via sanitizeDescription before returning", async () => {
    const { sanitizeDescription } = await import("@/lib/sanitize-description");
    const req = makeRequest("http://localhost:3000/api/mcp/workflows");
    const res = await GET(req);
    const body = (await res.json()) as { items: { description: string }[] };

    expect(sanitizeDescription).toHaveBeenCalledWith("Does things");
    expect(sanitizeDescription).toHaveBeenCalledWith("Also does things");
    for (const item of body.items) {
      expect(item.description).toMatch(SANITIZED_PREFIX_RE);
    }
  });

  it("response has Cache-Control: public, max-age=300, stale-while-revalidate=600 header", async () => {
    const req = makeRequest("http://localhost:3000/api/mcp/workflows");
    const res = await GET(req);

    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=600"
    );
  });

  it("?category=defi adds ilike filter on category column", async () => {
    const { ilike } = await import("drizzle-orm");
    const req = makeRequest(
      "http://localhost:3000/api/mcp/workflows?category=defi"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    expect(ilike).toHaveBeenCalledWith("category", "%defi%");
  });

  it("?chain=8453 adds ilike filter on chain column", async () => {
    const { ilike } = await import("drizzle-orm");
    const req = makeRequest(
      "http://localhost:3000/api/mcp/workflows?chain=8453"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    expect(ilike).toHaveBeenCalledWith("chain", "%8453%");
  });

  it("?q=swap&category=defi combines text search with category filter via and()", async () => {
    const { ilike, and } = await import("drizzle-orm");
    const req = makeRequest(
      "http://localhost:3000/api/mcp/workflows?q=swap&category=defi"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    expect(ilike).toHaveBeenCalledWith("name", "%swap%");
    expect(ilike).toHaveBeenCalledWith("category", "%defi%");
    expect(and).toHaveBeenCalled();
  });

  it("?q=swap&chain=8453 combines text search with chain filter via and()", async () => {
    const { ilike, and } = await import("drizzle-orm");
    const req = makeRequest(
      "http://localhost:3000/api/mcp/workflows?q=swap&chain=8453"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    expect(ilike).toHaveBeenCalledWith("name", "%swap%");
    expect(ilike).toHaveBeenCalledWith("chain", "%8453%");
    expect(and).toHaveBeenCalled();
  });

  it("response items include workflowType field", async () => {
    setupDbMocks(1, [{ ...LISTED_WORKFLOW, workflowType: "read" as const }]);
    const req = makeRequest("http://localhost:3000/api/mcp/workflows");
    const res = await GET(req);
    const body = (await res.json()) as { items: Record<string, unknown>[] };

    expect(body.items[0]).toHaveProperty("workflowType", "read");
  });

  it("?workflowType=write adds eq filter on workflow_type column", async () => {
    const { eq } = await import("drizzle-orm");
    const req = makeRequest(
      "http://localhost:3000/api/mcp/workflows?workflowType=write"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    expect(eq).toHaveBeenCalledWith("workflow_type", "write");
  });

  it("?workflowType=read adds eq filter on workflow_type column", async () => {
    const { eq } = await import("drizzle-orm");
    const req = makeRequest(
      "http://localhost:3000/api/mcp/workflows?workflowType=read"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    expect(eq).toHaveBeenCalledWith("workflow_type", "read");
  });

  it("?workflowType=invalid returns 400", async () => {
    const req = makeRequest(
      "http://localhost:3000/api/mcp/workflows?workflowType=foo"
    );
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/workflowType/);
  });
});
