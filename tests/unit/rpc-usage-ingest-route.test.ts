import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  restore: vi.fn(),
  flush: vi.fn(),
}));
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: mocks.authenticate,
}));
vi.mock("@/lib/rpc/engine", () => ({
  rpcUsageAccumulator: { restore: mocks.restore },
}));
vi.mock("@/lib/rpc/engine/usage-store", () => ({
  flushRpcUsage: mocks.flush,
}));

import { POST } from "@/app/api/internal/rpc-usage/route";
import { RpcOrigin, RpcTransport } from "@/lib/rpc/engine/types";

const HOUR = "2026-01-01T10:00:00.000Z";

function bucket(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "org_1",
    configId: "cfg_main",
    origin: RpcOrigin.ORG,
    chainId: 1,
    transport: RpcTransport.WSS,
    hour: HOUR,
    counters: { wsConnects: 1, eventsReceived: 4 },
    ...overrides,
  };
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/internal/rpc-usage", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

describe("POST /api/internal/rpc-usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({ authenticated: true });
    mocks.flush.mockResolvedValue(1);
  });

  it("refuses callers without a valid service signature", async () => {
    mocks.authenticate.mockResolvedValue({
      authenticated: false,
      status: 401,
      error: "Unauthorized",
    });
    const res = await post({ buckets: [bucket()] });
    expect(res.status).toBe(401);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("signs over the exact raw body", async () => {
    const raw = JSON.stringify({ buckets: [bucket()] });
    await post(raw);
    expect(mocks.authenticate).toHaveBeenCalledWith(expect.any(Request), raw);
  });

  it("stores the reported counts with missing counters as zero", async () => {
    const res = await post({ buckets: [bucket()] });
    expect(res.status).toBe(200);
    const [[buckets]] = mocks.restore.mock.calls;
    expect(buckets[0]).toMatchObject({
      organizationId: "org_1",
      origin: RpcOrigin.ORG,
      hour: new Date(HOUR),
      counters: { wsConnects: 1, eventsReceived: 4, requests: 0, errors: 0 },
    });
    expect(mocks.flush).toHaveBeenCalled();
  });

  it("rejects malformed reports", async () => {
    expect((await post("not json")).status).toBe(400);
    expect(
      (await post({ buckets: [bucket({ origin: "somewhere" })] })).status
    ).toBe(400);
    expect(
      (await post({ buckets: [bucket({ counters: { requests: -1 } })] })).status
    ).toBe(400);
    expect(mocks.restore).not.toHaveBeenCalled();
  });
});
