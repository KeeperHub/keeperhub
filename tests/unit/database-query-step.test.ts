import { beforeEach, describe, expect, it, vi } from "vitest";

// Server-only guard module loads "server-only"; stub it for vitest.
vi.mock("server-only", () => ({}));

// Hoisted mocks shared by the vi.mock factories below.
const { mockFetchCredentials, mockPostgres, mockLookup, mockWithStepLogging } =
  vi.hoisted(() => ({
    mockFetchCredentials: vi.fn(),
    mockPostgres: vi.fn(),
    mockLookup: vi.fn(),
    mockWithStepLogging: vi.fn(
      (_input: unknown, fn: () => unknown) => fn() as unknown
    ),
  }));

vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) =>
    mockFetchCredentials(...(args as [string])),
}));

vi.mock("postgres", () => ({
  default: (...args: unknown[]) => mockPostgres(...args),
}));

vi.mock("node:dns", () => ({
  promises: { lookup: mockLookup },
}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (...args: unknown[]) =>
    mockWithStepLogging(...(args as [unknown, () => unknown])),
}));

import {
  type DatabaseQueryInput,
  databaseQueryStep,
  resolveConnectTimeoutSeconds,
  resolveRetries,
} from "@/lib/workflow/nodes/database-query/step";

const STEP_INPUT_BASE: DatabaseQueryInput = {
  integrationId: "integration-1",
  dbQuery: "SELECT 1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("databaseQueryStep guard wiring", () => {
  it.each([
    ["IPv4 IMDS link-local", "postgres://u:p@169.254.169.254:5432/db"],
    ["IPv4 private 10/8", "postgres://u:p@10.0.0.5:5432/db"],
    ["IPv4 loopback", "postgres://u:p@127.0.0.1:5432/db"],
    ["IPv6 loopback bracketed", "postgres://u:p@[::1]:5432/db"],
    ["IPv6 ULA bracketed", "postgres://u:p@[fc00::1]:5432/db"],
  ])("rejects %s before opening a socket", async (_label, url) => {
    mockFetchCredentials.mockResolvedValue({ DATABASE_URL: url });

    const result = (await databaseQueryStep(STEP_INPUT_BASE)) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockPostgres).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each([
    ["localhost", "postgres://u:p@localhost:5432/db"],
    [
      "k8s service DNS",
      "postgres://u:p@db.keeperhub.svc.cluster.local:5432/db",
    ],
    [
      "EC2 internal hostname",
      "postgres://u:p@ip-10-0-0-5.us-east-2.compute.internal:5432/db",
    ],
    ["mDNS suffix", "postgres://u:p@db.local:5432/db"],
  ])("rejects hostname pattern %s before any DNS lookup or socket", async (_label, url) => {
    mockFetchCredentials.mockResolvedValue({ DATABASE_URL: url });

    const result = (await databaseQueryStep(STEP_INPUT_BASE)) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockPostgres).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects hostname that resolves to a private address", async () => {
    mockFetchCredentials.mockResolvedValue({
      DATABASE_URL: "postgres://u:p@db.example:5432/db",
    });
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    const result = (await databaseQueryStep(STEP_INPUT_BASE)) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Host is not allowed: must resolve to a public address"
    );
    expect(mockLookup).toHaveBeenCalled();
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it("does not leak the connection string in the error", async () => {
    const url =
      "postgres://supersecretuser:supersecretpassword@10.0.0.1:5432/internal";
    mockFetchCredentials.mockResolvedValue({ DATABASE_URL: url });

    const result = (await databaseQueryStep(STEP_INPUT_BASE)) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    const error = result.error ?? "";
    expect(error).not.toContain("supersecret");
    expect(error).not.toContain("10.0.0.1");
    expect(error).not.toContain("internal");
  });
});

function makeClient(unsafe: (...args: unknown[]) => Promise<unknown>): {
  unsafe: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  return {
    unsafe: vi.fn(unsafe),
    end: vi.fn(() => Promise.resolve()),
  };
}

// Uses the _dbParams path so executeQuery routes through client.unsafe (which
// the postgres mock controls) instead of drizzle, which is not mocked.
const PUBLIC_DB_INPUT: DatabaseQueryInput = {
  integrationId: "integration-1",
  dbQuery: "SELECT $1",
  _dbParams: ["x"],
};

function connectTimeoutError(): Error {
  const error = new Error("write CONNECT_TIMEOUT") as Error & { code?: string };
  error.code = "CONNECT_TIMEOUT";
  return error;
}

describe("resolveConnectTimeoutSeconds", () => {
  it("defaults to 30 for missing / empty / non-numeric", () => {
    expect(resolveConnectTimeoutSeconds(undefined)).toBe(30);
    expect(resolveConnectTimeoutSeconds(null)).toBe(30);
    expect(resolveConnectTimeoutSeconds("")).toBe(30);
    expect(resolveConnectTimeoutSeconds("abc")).toBe(30);
  });

  it("coerces strings and clamps to [1, 60]", () => {
    expect(resolveConnectTimeoutSeconds("45")).toBe(45);
    expect(resolveConnectTimeoutSeconds(0)).toBe(1);
    expect(resolveConnectTimeoutSeconds(999)).toBe(60);
  });
});

describe("resolveRetries", () => {
  it("defaults to 1 for missing / empty / non-numeric", () => {
    expect(resolveRetries(undefined)).toBe(1);
    expect(resolveRetries(null)).toBe(1);
    expect(resolveRetries("")).toBe(1);
    expect(resolveRetries("abc")).toBe(1);
  });

  it("coerces, truncates, and clamps to [0, 3]", () => {
    expect(resolveRetries("2")).toBe(2);
    expect(resolveRetries(-5)).toBe(0);
    expect(resolveRetries(99)).toBe(3);
    expect(resolveRetries(1.9)).toBe(1);
  });
});

describe("databaseQueryStep connection timeout + retry", () => {
  beforeEach(() => {
    mockFetchCredentials.mockResolvedValue({
      DATABASE_URL: "postgres://u:p@93.184.216.34:5432/db",
    });
  });

  it("passes the default 30s connect_timeout to postgres", async () => {
    mockPostgres.mockImplementation(() =>
      makeClient(() => Promise.resolve([{ ok: 1 }]))
    );

    const result = (await databaseQueryStep(PUBLIC_DB_INPUT)) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(mockPostgres).toHaveBeenCalledTimes(1);
    const options = mockPostgres.mock.calls[0][1] as {
      connect_timeout: number;
    };
    expect(options.connect_timeout).toBe(30);
  });

  it("passes a configured connect_timeout, clamped to 60", async () => {
    mockPostgres.mockImplementation(() =>
      makeClient(() => Promise.resolve([{ ok: 1 }]))
    );

    await databaseQueryStep({ ...PUBLIC_DB_INPUT, connectTimeout: 999 });

    const options = mockPostgres.mock.calls[0][1] as {
      connect_timeout: number;
    };
    expect(options.connect_timeout).toBe(60);
  });

  it("retries a CONNECT_TIMEOUT and succeeds on the second attempt", async () => {
    let call = 0;
    mockPostgres.mockImplementation(() =>
      makeClient(() => {
        call++;
        return call === 1
          ? Promise.reject(connectTimeoutError())
          : Promise.resolve([{ ok: 1 }]);
      })
    );

    const result = (await databaseQueryStep(PUBLIC_DB_INPUT)) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(mockPostgres).toHaveBeenCalledTimes(2);
  });

  it("does not retry a Postgres query error (write safety)", async () => {
    mockPostgres.mockImplementation(() =>
      makeClient(() => {
        const error = new Error("duplicate key value") as Error & {
          severity?: string;
        };
        error.severity = "ERROR";
        return Promise.reject(error);
      })
    );

    const result = (await databaseQueryStep({
      ...PUBLIC_DB_INPUT,
      retries: 3,
    })) as { success: boolean };

    expect(result.success).toBe(false);
    expect(mockPostgres).toHaveBeenCalledTimes(1);
  });

  it("does not retry a mid-query ECONNRESET (write safety)", async () => {
    mockPostgres.mockImplementation(() =>
      makeClient(() => {
        const error = new Error("write ECONNRESET") as Error & {
          code?: string;
        };
        error.code = "ECONNRESET";
        return Promise.reject(error);
      })
    );

    const result = (await databaseQueryStep({
      ...PUBLIC_DB_INPUT,
      retries: 3,
    })) as { success: boolean };

    expect(result.success).toBe(false);
    expect(mockPostgres).toHaveBeenCalledTimes(1);
  });

  it("stops after exhausting retries and returns a sanitized error", async () => {
    mockPostgres.mockImplementation(() =>
      makeClient(() => Promise.reject(connectTimeoutError()))
    );

    const result = (await databaseQueryStep({
      ...PUBLIC_DB_INPUT,
      retries: 2,
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(mockPostgres).toHaveBeenCalledTimes(3);
    expect(result.error ?? "").not.toContain("93.184.216.34");
  });

  it("retries a drizzle-wrapped connection error (code on error.cause)", async () => {
    let call = 0;
    mockPostgres.mockImplementation(() =>
      makeClient(() => {
        call++;
        if (call === 1) {
          // The non-parameterized path runs through drizzle, which wraps the
          // driver error so the real code lands on error.cause, not the top.
          const wrapped = new Error("Failed query: SELECT $1") as Error & {
            cause?: unknown;
          };
          wrapped.cause = Object.assign(
            new Error("connect ECONNREFUSED 10.1.2.3:5432"),
            { code: "ECONNREFUSED" }
          );
          return Promise.reject(wrapped);
        }
        return Promise.resolve([{ ok: 1 }]);
      })
    );

    const result = (await databaseQueryStep(PUBLIC_DB_INPUT)) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(mockPostgres).toHaveBeenCalledTimes(2);
  });

  it("does not retry a drizzle-wrapped Postgres query error (severity on cause)", async () => {
    mockPostgres.mockImplementation(() =>
      makeClient(() => {
        const wrapped = new Error("Failed query: INSERT ...") as Error & {
          cause?: unknown;
        };
        wrapped.cause = Object.assign(new Error("duplicate key value"), {
          severity: "ERROR",
          code: "23505",
        });
        return Promise.reject(wrapped);
      })
    );

    const result = (await databaseQueryStep({
      ...PUBLIC_DB_INPUT,
      retries: 3,
    })) as { success: boolean };

    expect(result.success).toBe(false);
    expect(mockPostgres).toHaveBeenCalledTimes(1);
  });
});
