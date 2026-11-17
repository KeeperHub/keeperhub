import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockPostgres } = vi.hoisted(() => ({
  mockPostgres: vi.fn(),
}));

vi.mock("postgres", () => ({
  default: (...args: unknown[]) => mockPostgres(...args),
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

  it.each([
    [
      "percent-encoded comma",
      "postgres://u:p@10.0.0.5%2Cx.attacker.example/db",
    ],
    ["plain comma", "postgres://u:p@a.example,b.example/db"],
  ])(
    "rejects a multi-host connection string (%s) before any client is built",
    async (_label, url) => {
      const result = await testDatabaseConnection(url);

      expect(result).toEqual({
        status: "error",
        message: HOST_NOT_ALLOWED_MESSAGE,
      });
      expect(mockPostgres).not.toHaveBeenCalled();
    }
  );
});
