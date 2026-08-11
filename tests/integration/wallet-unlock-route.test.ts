import { beforeEach, describe, expect, it, vi } from "vitest";

const INVALID_JSON_REGEX = /Invalid JSON/;

vi.mock("server-only", () => ({}));

const mockAuthResult = {
  authenticated: true,
  caller: "scheduler" as const,
  scheme: "hmac" as const,
  // Failure-path fields populated up front so tests that flip
  // `authenticated` to false still produce a well-formed 401 response.
  error: "Unauthorized",
  status: 401,
};
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: vi.fn(async () => mockAuthResult),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

let mockSelectResult: { lockedBy: string | null; expiresAt: Date }[] = [];
let mockUpdateRows: { walletAddress: string }[] = [];
let updateInvoked = false;
let selectThrows = false;

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            if (selectThrows) {
              throw new Error("db blew up");
            }
            return Promise.resolve(mockSelectResult);
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => {
            updateInvoked = true;
            return Promise.resolve(mockUpdateRows);
          }),
        })),
      })),
    })),
  },
}));

const { walletLocksMock } = vi.hoisted(() => ({
  walletLocksMock: {
    walletAddress: "wallet_address",
    chainId: "chain_id",
    lockedBy: "locked_by",
    lockedAt: "locked_at",
    expiresAt: "expires_at",
  },
}));

vi.mock("@/lib/db/schema-extensions", () => ({
  walletLocks: walletLocksMock,
}));

import { POST } from "@/app/api/internal/wallet-unlock/route";

function createRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/internal/wallet-unlock", {
    method: "POST",
    headers: {
      "X-KH-Caller": "scheduler",
      "Content-Type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/internal/wallet-unlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult.authenticated = true;
    mockSelectResult = [];
    mockUpdateRows = [];
    updateInvoked = false;
    selectThrows = false;
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthResult.authenticated = false;

    const response = await POST(
      createRequest({
        walletAddress: "0x1234567890123456789012345678901234567890",
        chainId: 1,
      })
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 on invalid JSON body", async () => {
    const response = await POST(createRequest("not-json"));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(INVALID_JSON_REGEX);
  });

  it("returns 400 when walletAddress is missing", async () => {
    const response = await POST(createRequest({ chainId: 1 }));
    expect(response.status).toBe(400);
  });

  it("returns 400 when chainId is missing", async () => {
    const response = await POST(
      createRequest({
        walletAddress: "0x1234567890123456789012345678901234567890",
      })
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when chainId is not an integer", async () => {
    const response = await POST(
      createRequest({
        walletAddress: "0x1234567890123456789012345678901234567890",
        chainId: 1.5,
      })
    );
    expect(response.status).toBe(400);
  });

  it("returns released:false when no lock is held", async () => {
    mockSelectResult = [];

    const response = await POST(
      createRequest({
        walletAddress: "0x1234567890123456789012345678901234567890",
        chainId: 1,
      })
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ released: false, previousHolder: null });
    expect(updateInvoked).toBe(false);
  });

  it("returns released:false when row exists but lockedBy is null", async () => {
    mockSelectResult = [
      { lockedBy: null, expiresAt: new Date(Date.now() - 1000) },
    ];

    const response = await POST(
      createRequest({
        walletAddress: "0x1234567890123456789012345678901234567890",
        chainId: 1,
      })
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ released: false, previousHolder: null });
    expect(updateInvoked).toBe(false);
  });

  it("releases an active lock and returns the previous holder", async () => {
    mockSelectResult = [
      {
        lockedBy: "exec_wedged",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    // The conditional UPDATE finds the row (still held by exec_wedged).
    mockUpdateRows = [
      { walletAddress: "0x1234567890123456789012345678901234567890" },
    ];

    const response = await POST(
      createRequest({
        walletAddress: "0x1234567890123456789012345678901234567890",
        chainId: 1,
      })
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ released: true, previousHolder: "exec_wedged" });
    expect(updateInvoked).toBe(true);
  });

  // Race protection: the lock can be legitimately released and re-acquired
  // between our SELECT and our UPDATE. The conditional UPDATE (WHERE
  // locked_by = previousHolder) returns 0 rows in that case; we must not
  // report success and must not have killed an unrelated holder.
  it("returns released:false when the holder changed between SELECT and UPDATE", async () => {
    mockSelectResult = [
      {
        lockedBy: "exec_first",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    // Conditional UPDATE matches no row — someone else now holds it.
    mockUpdateRows = [];

    const response = await POST(
      createRequest({
        walletAddress: "0x1234567890123456789012345678901234567890",
        chainId: 1,
      })
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ released: false, previousHolder: null });
  });

  it("normalizes wallet address to lowercase before lookup", async () => {
    mockSelectResult = [
      {
        lockedBy: "exec_wedged",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ];
    mockUpdateRows = [
      { walletAddress: "0xabcdef1234567890123456789012345678901234" },
    ];

    const response = await POST(
      createRequest({
        walletAddress: "0xABCDEF1234567890123456789012345678901234",
        chainId: 1,
      })
    );

    expect(response.status).toBe(200);
    expect(updateInvoked).toBe(true);
  });

  it("returns 500 if the database errors", async () => {
    selectThrows = true;

    const response = await POST(
      createRequest({
        walletAddress: "0x1234567890123456789012345678901234567890",
        chainId: 1,
      })
    );

    expect(response.status).toBe(500);
  });
});
