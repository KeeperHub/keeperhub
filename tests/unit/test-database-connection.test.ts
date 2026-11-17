import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockPostgres, mockLookup } = vi.hoisted(() => ({
  mockPostgres: vi.fn(),
  mockLookup: vi.fn(),
}));

vi.mock("postgres", () => ({
  default: (...args: unknown[]) => mockPostgres(...args),
}));

vi.mock("node:dns", () => ({
  promises: { lookup: mockLookup },
}));

vi.mock("@/plugins/registry", () => ({
  getCredentialMapping: vi.fn(),
  getIntegration: vi.fn(),
}));

import { HOST_NOT_ALLOWED_MESSAGE } from "@/lib/db/connection-utils";
import { testDatabaseConnection } from "@/lib/db/test-connection";

function makeClient(): (() => Promise<unknown>) & { end: () => Promise<void> } {
  return Object.assign(() => Promise.resolve([{ "?column?": 1 }]), {
    end: () => Promise.resolve(),
  });
}

beforeEach(() => {
  mockPostgres.mockReset();
  mockLookup.mockReset();
});

describe("testDatabaseConnection", () => {
  it("passes the public-only socket factory and the 5s timeout to postgres", async () => {
    mockPostgres.mockImplementation(makeClient);

    const result = await testDatabaseConnection(
      "postgres://u:p@93.184.216.34:5432/db"
    );

    expect(result.status).toBe("success");
    const options = mockPostgres.mock.calls[0][1] as {
      connect_timeout: number;
      socket?: unknown;
    };
    expect(options.connect_timeout).toBe(5);
    expect(typeof options.socket).toBe("function");
  });

  it("refuses a host that resolves to a private address before any client", async () => {
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    const result = await testDatabaseConnection(
      "postgres://u:p@db.example:5432/db"
    );

    expect(result).toEqual({
      status: "error",
      message: HOST_NOT_ALLOWED_MESSAGE,
    });
    expect(mockPostgres).not.toHaveBeenCalled();
  });
});
