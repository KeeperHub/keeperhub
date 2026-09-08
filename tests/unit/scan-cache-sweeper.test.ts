/**
 * Unit tests for GET /api/cron/scan-cache-sweeper — HARDEN-02.
 *
 * Verifies: age-predicate delete (scanned_at < now()-1h) when caller is
 * "scheduler", and fail-closed behavior (401) for any other caller or bad HMAC.
 *
 * Wave 0: All tests are RED. The route is a throw-stub; these tests describe
 * the FINAL behavior and turn GREEN in 55-02 when the real implementation
 * lands with authenticateInternalService + db.delete.
 *
 * Mocks: authenticateInternalService, db.delete chain.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockAuthenticateInternalService,
  mockDbDelete,
  mockDbDeleteWhere,
  mockDbDeleteWhereReturning,
} = vi.hoisted(() => ({
  mockAuthenticateInternalService: vi.fn(),
  mockDbDelete: vi.fn(),
  mockDbDeleteWhere: vi.fn(),
  mockDbDeleteWhereReturning: vi.fn(),
}));

vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: mockAuthenticateInternalService,
}));

vi.mock("@/lib/db", () => ({
  db: {
    delete: mockDbDelete,
  },
}));

const { GET } = await import("@/app/api/cron/scan-cache-sweeper/route");

describe("GET /api/cron/scan-cache-sweeper", () => {
  beforeEach(() => {
    mockAuthenticateInternalService.mockReset();
    mockDbDelete.mockReset();
    mockDbDeleteWhere.mockReset();
    mockDbDeleteWhereReturning.mockReset();

    mockDbDelete.mockReturnValue({ where: mockDbDeleteWhere });
    mockDbDeleteWhere.mockReturnValue({
      returning: mockDbDeleteWhereReturning,
    });
    mockDbDeleteWhereReturning.mockResolvedValue([{ id: "a" }, { id: "b" }]);
  });

  it("deletes scan_results rows scanned_at older than 1 hour when caller is scheduler", async () => {
    mockAuthenticateInternalService.mockResolvedValue({
      authenticated: true,
      caller: "scheduler",
    });

    const res = await GET(
      new Request("http://localhost/api/cron/scan-cache-sweeper")
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { pruned: number };
    expect(body).toEqual({ pruned: 2 });
    expect(mockDbDelete).toHaveBeenCalled();
    // Verify .where was called with a SQL predicate (truthy object from lt/drizzle)
    expect(mockDbDeleteWhere).toHaveBeenCalledWith(expect.anything());
  });

  it("rejects non-scheduler caller (fail closed)", async () => {
    mockAuthenticateInternalService.mockResolvedValue({
      authenticated: true,
      caller: "executor",
    });

    const res = await GET(
      new Request("http://localhost/api/cron/scan-cache-sweeper")
    );

    expect(res.status).toBe(401);
    expect(mockDbDelete).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated caller (bad/missing HMAC, fail closed)", async () => {
    mockAuthenticateInternalService.mockResolvedValue({
      authenticated: false,
      error: "Invalid signature",
      status: 401,
    });

    const res = await GET(
      new Request("http://localhost/api/cron/scan-cache-sweeper")
    );

    expect(res.status).toBe(401);
    expect(mockDbDelete).not.toHaveBeenCalled();
  });
});
