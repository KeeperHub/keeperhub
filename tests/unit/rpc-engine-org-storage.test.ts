import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dbMock = vi.hoisted(() => ({
  onConflictDoUpdate: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: () => ({ onConflictDoUpdate: dbMock.onConflictDoUpdate }),
    }),
  },
}));
vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logSystemWarn: vi.fn(),
}));

import type { OrganizationRpcConfigRow } from "@/lib/db/schema-rpc";
import {
  decodeRpcConfigUrls,
  encodeRpcConfigUrls,
  filledRpcConfigSlots,
  orgRpcConfigFromRow,
} from "@/lib/rpc/engine/org/codec";
import { RpcConfigUrlSlot } from "@/lib/rpc/engine/org/url-slots";
import { RpcUsageAccumulator } from "@/lib/rpc/engine/telemetry/usage";
import { RpcOrigin, RpcTransport } from "@/lib/rpc/engine/types";
import { flushRpcUsage } from "@/lib/rpc/engine/usage-store";

const KEY_ENV = "INTEGRATION_ENCRYPTION_KEY";
const TEST_KEY = "ab".repeat(32);
const SECRET = "k3y0123456789abcdef0123456789abcd";

let previousKey: string | undefined;

beforeAll(() => {
  previousKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = TEST_KEY;
});

afterAll(() => {
  process.env[KEY_ENV] = previousKey;
});

describe("RPC config codec", () => {
  const urls = {
    [RpcConfigUrlSlot.HTTP_PRIMARY]: `https://rpc.example.com/v2/${SECRET}`,
    [RpcConfigUrlSlot.WSS_PRIMARY]: `wss://rpc.example.com/v2/${SECRET}`,
  };

  it("round-trips URLs through encryption", () => {
    const encryptedUrls = encodeRpcConfigUrls(urls);
    expect(encryptedUrls).not.toContain(SECRET);
    expect(decodeRpcConfigUrls(encryptedUrls)).toEqual(urls);
  });

  it("exposes only which slots are set", () => {
    const slots = filledRpcConfigSlots(encodeRpcConfigUrls(urls));
    expect(slots).toEqual([
      RpcConfigUrlSlot.HTTP_PRIMARY,
      RpcConfigUrlSlot.WSS_PRIMARY,
    ]);
  });

  it("builds resolver configs from stored rows", () => {
    const encryptedUrls = encodeRpcConfigUrls(urls);
    const row: OrganizationRpcConfigRow = {
      id: "cfg_main",
      organizationId: "org_1",
      chainId: 1,
      name: "Main",
      isDefault: true,
      enabled: true,
      encryptedUrls,
      verification: {},
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const config = orgRpcConfigFromRow(row);
    expect(config.httpPrimary.reveal()).toBe(urls.httpPrimary);
    expect(config.wssPrimary?.reveal()).toBe(urls.wssPrimary);
    expect(config.httpFallback).toBeUndefined();
  });
});

describe("flushRpcUsage", () => {
  const key = {
    organizationId: "org_1",
    configId: "cfg_main",
    origin: RpcOrigin.ORG,
    chainId: 1,
    transport: RpcTransport.HTTP,
  };

  it("writes the drained buckets", async () => {
    dbMock.onConflictDoUpdate.mockResolvedValueOnce(undefined);
    const accumulator = new RpcUsageAccumulator();
    accumulator.record(key, { requests: 3 });

    await expect(flushRpcUsage(accumulator)).resolves.toBe(1);
    expect(accumulator.size).toBe(0);
  });

  it("keeps the counts for the next flush when the write fails", async () => {
    dbMock.onConflictDoUpdate.mockRejectedValueOnce(new Error("db down"));
    const accumulator = new RpcUsageAccumulator();
    accumulator.record(key, { requests: 3 });

    await expect(flushRpcUsage(accumulator)).resolves.toBe(0);
    const [bucket] = accumulator.drain();
    expect(bucket.counters.requests).toBe(3);
  });

  it("does nothing when there is nothing to write", async () => {
    dbMock.onConflictDoUpdate.mockClear();
    await expect(flushRpcUsage(new RpcUsageAccumulator())).resolves.toBe(0);
    expect(dbMock.onConflictDoUpdate).not.toHaveBeenCalled();
  });
});
