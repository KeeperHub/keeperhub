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

/**
 * A chainable stub standing in for the drizzle builder. It records the calls
 * the route makes so the test can assert on the query that was built rather
 * than on a database, and resolves to `rows` when awaited.
 */
function queryStub(rows: unknown[]) {
  const calls: { limit?: number; offset?: number; orderBy: number } = {
    orderBy: 0,
  };
  const builder: Record<string, unknown> = {
    from: () => builder,
    where: () => builder,
    orderBy: (...args: unknown[]) => {
      calls.orderBy = args.length;
      return builder;
    },
    limit: (n: number) => {
      calls.limit = n;
      return builder;
    },
    offset: (n: number) => {
      calls.offset = n;
      return builder;
    },
    // biome-ignore lint/suspicious/noThenProperty: drizzle's builder is itself a thenable and the route awaits it, so the stub has to be one too.
    then: (resolve: (value: unknown) => unknown) => resolve(rows),
  };
  return { builder, calls };
}

const row = (id: string) => ({
  id,
  organizationId: "org_1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const call = (url: string) => GET(new Request(url));

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ organizationId: "org_1" });
});

describe("GET /api/workflows paging", () => {
  it("returns every row when limit is absent", async () => {
    const { builder, calls } = queryStub([row("a"), row("b")]);
    mockSelect.mockReturnValue(builder);

    const res = await call("https://x.test/api/workflows");

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(2);
    expect(calls.limit).toBeUndefined();
  });

  it("applies limit and offset", async () => {
    const { builder, calls } = queryStub([row("a")]);
    mockSelect.mockReturnValue(builder);

    const res = await call("https://x.test/api/workflows?limit=10&offset=20");

    expect(res.status).toBe(200);
    expect(calls.limit).toBe(10);
    expect(calls.offset).toBe(20);
  });

  it("answers a bare array whether or not a page was asked for", async () => {
    // docs/api/index.md tells client authors to key unwrapping on the endpoint,
    // so the paged and unpaged responses cannot differ in shape.
    const { builder } = queryStub([row("a")]);
    mockSelect.mockReturnValue(builder);

    const unpaged = await (await call("https://x.test/api/workflows")).json();
    const paged = await (
      await call("https://x.test/api/workflows?limit=10")
    ).json();

    expect(Array.isArray(unpaged)).toBe(true);
    expect(Array.isArray(paged)).toBe(true);
  });

  it("rejects a limit above MAX_PAGE_SIZE rather than clamping to it", async () => {
    // A bare array has no meta.pageSize to report a clamp through, so a
    // shortened page would be indistinguishable from the end of the list.
    // lib/pagination.ts can clamp because its envelope says what it used.
    const { builder } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    const res = await call("https://x.test/api/workflows?limit=1000000");

    expect(res.status).toBe(400);
    expect((await res.json()).detail).toMatch(/limit must be <= 200/);
  });

  it("accepts limit at exactly MAX_PAGE_SIZE", async () => {
    const { builder, calls } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    const res = await call("https://x.test/api/workflows?limit=200");

    expect(res.status).toBe(200);
    expect(calls.limit).toBe(200);
  });

  it("accepts offset=0, which is page one of every pager", async () => {
    // The regression this exists for: offset shared limit's `> 0` rule, so
    // `for (let p = 0; ; p++) fetch(?limit=50&offset=${p * 50})` 400d on its
    // first request - the one call every paging client makes.
    const { builder, calls } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    const res = await call("https://x.test/api/workflows?limit=50&offset=0");

    expect(res.status).toBe(200);
    expect(calls.offset).toBe(0);
  });

  it.each([
    "1e20",
    "99999999999999999999",
    "-1",
  ])("rejects offset=%s rather than letting Postgres reject it", async (value) => {
    // Number.isInteger(1e20) is true, so an unbounded offset reaches the
    // driver as a bigint overflow and the caller gets a raw database message.
    const { builder } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    const res = await call(
      `https://x.test/api/workflows?limit=10&offset=${encodeURIComponent(value)}`
    );

    expect(res.status).toBe(400);
    expect((await res.json()).detail).toMatch(/offset/);
  });

  it.each([
    "0x1f4",
    "1e2",
    " 5",
  ])("rejects limit=%s, which Number() would have silently accepted", async (value) => {
    const { builder } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    const res = await call(
      `https://x.test/api/workflows?limit=${encodeURIComponent(value)}`
    );

    expect(res.status).toBe(400);
  });

  it("sorts by a total order so pages cannot overlap", async () => {
    // createdAt is not unique, so a single-column sort lets a row on a page
    // boundary appear twice while another is skipped.
    const { builder, calls } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    await call("https://x.test/api/workflows");

    expect(calls.orderBy).toBe(2);
  });

  it.each([
    "abc",
    "0",
    "-1",
    "",
  ])("rejects limit=%s rather than returning the whole list", async (value) => {
    const { builder } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    const res = await call(
      `https://x.test/api/workflows?limit=${encodeURIComponent(value)}`
    );

    expect(res.status).toBe(400);
    expect((await res.json()).detail).toMatch(/limit/);
  });

  it("rejects offset without limit", async () => {
    const { builder } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    const res = await call("https://x.test/api/workflows?offset=100");

    expect(res.status).toBe(400);
    expect((await res.json()).detail).toMatch(/offset requires limit/);
  });

  it("answers the documented error envelope on a rejection", async () => {
    // docs/api/errors.md: `error` is the stable code an integrator branches on,
    // the sentence lives in `detail`, and the correlation id is echoed on the
    // response header. The auth branch of this route already answers this way.
    const { builder } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    const res = await call("https://x.test/api/workflows?limit=abc");
    const body = await res.json();

    expect(body.error).toBe("invalid_input");
    expect(typeof body.detail).toBe("string");
    expect(res.headers.get("x-request-id")).toBe(body.request_id);
  });

  it("echoes an inbound correlation id rather than minting a new one", async () => {
    const { builder } = queryStub([]);
    mockSelect.mockReturnValue(builder);

    const inbound = "b3c1e2f0-2a4d-4a1e-9c3f-0f2b7c1d5e6a";
    const res = await GET(
      new Request("https://x.test/api/workflows?limit=abc", {
        headers: { "x-request-id": inbound },
      })
    );

    expect((await res.json()).request_id).toBe(inbound);
  });
});
