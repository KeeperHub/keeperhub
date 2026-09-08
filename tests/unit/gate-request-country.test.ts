import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetRedis, mockHeaders, mockLimit } = vi.hoisted(() => ({
  mockGetRedis: vi.fn(),
  mockHeaders: vi.fn(),
  mockLimit: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mockHeaders }));
vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));
// db.select(...).from(...).where(...).limit(1) -> mockLimit()
// db.insert(...).values(...).onConflictDoUpdate(...) -> mockInsert() (bridge backfill)
const mockInsert = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: mockLimit }) }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: mockInsert }),
    }),
  },
}));

import { gateRequestCountry } from "@/lib/security/login-risk";

type RedisLike = {
  get: (key: string) => Promise<unknown>;
  set: (...args: unknown[]) => Promise<unknown>;
};

function headersWith(values: Record<string, string>): {
  get: (key: string) => string | null;
} {
  return { get: (key: string) => values[key.toLowerCase()] ?? null };
}

const CF_HEADERS = { "cf-connecting-ip": "9.9.9.9", "cf-ipcountry": "DE" };
const TRUST_KEY = "local:trust-country:u1:DE";

beforeEach(() => {
  mockGetRedis.mockReset();
  mockHeaders.mockReset();
  mockLimit.mockReset();
  mockInsert.mockClear();
  mockHeaders.mockResolvedValue(headersWith(CF_HEADERS));
});

describe("gateRequestCountry read-through Redis cache", () => {
  it("returns no_country when CF did not attest a country", async () => {
    mockHeaders.mockResolvedValue(
      headersWith({ "cf-connecting-ip": "9.9.9.9" })
    );
    mockGetRedis.mockReturnValue(null);

    expect(await gateRequestCountry("u1")).toEqual({ kind: "no_country" });
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it("treats CF's XX sentinel as no_country", async () => {
    mockHeaders.mockResolvedValue(
      headersWith({ "cf-connecting-ip": "9.9.9.9", "cf-ipcountry": "XX" })
    );
    mockGetRedis.mockReturnValue(null);

    expect(await gateRequestCountry("u1")).toEqual({ kind: "no_country" });
  });

  it("ignores a forged cf-ipcountry that lacks the CF-set connecting IP", async () => {
    // No cf-connecting-ip means the request did not transit Cloudflare, so a
    // cf-ipcountry header is caller-controlled and must not pin a country.
    mockHeaders.mockResolvedValue(headersWith({ "cf-ipcountry": "US" }));
    mockGetRedis.mockReturnValue(null);

    expect(await gateRequestCountry("u1")).toEqual({ kind: "no_country" });
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it("serves trusted from a Redis hit without touching the DB", async () => {
    const get = vi.fn().mockResolvedValue("1");
    mockGetRedis.mockReturnValue({ get, set: vi.fn() } as RedisLike);

    expect(await gateRequestCountry("u1")).toEqual({ kind: "trusted" });
    expect(get).toHaveBeenCalledWith(TRUST_KEY);
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it("on a Redis miss reads the DB, returns trusted, and re-caches", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const set = vi.fn().mockResolvedValue("OK");
    mockGetRedis.mockReturnValue({ get, set } as RedisLike);
    mockLimit.mockResolvedValue([{ id: "row-1" }]);

    expect(await gateRequestCountry("u1")).toEqual({ kind: "trusted" });
    expect(mockLimit).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(set).toHaveBeenCalledWith(TRUST_KEY, "1", "EX", 300)
    );
  });

  it("returns untrusted (full ip + country) when neither country nor legacy IP is trusted", async () => {
    const get = vi.fn().mockResolvedValue(null);
    mockGetRedis.mockReturnValue({ get, set: vi.fn() } as RedisLike);
    // Country miss, then legacy-IP miss.
    mockLimit.mockResolvedValue([]);

    expect(await gateRequestCountry("u1")).toEqual({
      kind: "untrusted",
      country: "DE",
      ip: "9.9.9.9",
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("bridges a legacy trusted IP: passes and backfills the country", async () => {
    const get = vi.fn().mockResolvedValue(null);
    mockGetRedis.mockReturnValue({ get, set: vi.fn() } as RedisLike);
    // Country miss, then legacy user_trusted_ips hit.
    mockLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "legacy-ip" }]);

    expect(await gateRequestCountry("u1")).toEqual({ kind: "trusted" });
    // The country was backfilled into user_trusted_countries.
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("falls back to the DB when Redis is not configured", async () => {
    mockGetRedis.mockReturnValue(null);
    mockLimit.mockResolvedValue([{ id: "row-1" }]);

    expect(await gateRequestCountry("u1")).toEqual({ kind: "trusted" });
    expect(mockLimit).toHaveBeenCalledTimes(1);
  });

  it("falls back to the DB when the Redis read throws", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    mockGetRedis.mockReturnValue({ get, set: vi.fn() } as RedisLike);
    mockLimit.mockResolvedValue([{ id: "row-1" }]);

    expect(await gateRequestCountry("u1")).toEqual({ kind: "trusted" });
    expect(mockLimit).toHaveBeenCalledTimes(1);
  });
});
