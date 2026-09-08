import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockAuth, mockSelect } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: (...args: unknown[]) => mockAuth(...args),
  authFailureResponse: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { select: (...args: unknown[]) => mockSelect(...args) },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

import { GET } from "@/app/api/workflows/route";

/** Chainable drizzle stub that records the predicate handed to where(). */
function queryStub(rows: unknown[]) {
  const calls: { where?: unknown } = {};
  const builder: Record<string, unknown> = {
    from: () => builder,
    where: (predicate: unknown) => {
      calls.where = predicate;
      return builder;
    },
    orderBy: () => builder,
    limit: () => builder,
    offset: () => builder,
    // biome-ignore lint/suspicious/noThenProperty: drizzle's builder is itself a thenable and the route awaits it, so the stub has to be one too.
    then: (resolve: (value: unknown) => unknown) => resolve(rows),
  };
  return { builder, calls };
}

/** Every column referenced anywhere in a drizzle SQL predicate tree. */
function columnsIn(node: unknown, found: string[] = []): string[] {
  if (node === null || typeof node !== "object") {
    return found;
  }
  const candidate = node as { name?: unknown; queryChunks?: unknown };
  if (typeof candidate.name === "string" && "table" in candidate) {
    found.push(candidate.name);
  }
  const chunks = candidate.queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      columnsIn(chunk, found);
    }
  }
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ organizationId: "org_1" });
});

describe("GET /api/workflows soft-delete", () => {
  it("filters deleted rows in the query rather than leaving it to the caller", async () => {
    const { builder, calls } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    await GET(new Request("http://localhost/api/workflows"));

    const columns = columnsIn(calls.where);
    expect(columns).toContain("deleted_at");
    expect(columns).toContain("organization_id");
  });

  it("keeps filtering deleted rows when a project filter narrows the list", async () => {
    const { builder, calls } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    await GET(new Request("http://localhost/api/workflows?projectId=proj_1"));

    const columns = columnsIn(calls.where);
    expect(columns).toContain("deleted_at");
    expect(columns).toContain("project_id");
  });
});
