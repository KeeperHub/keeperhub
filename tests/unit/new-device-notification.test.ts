import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetRedis, mockSendEmail } = vi.hoisted(() => ({
  mockGetRedis: vi.fn(),
  mockSendEmail: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));
vi.mock("@/lib/email", () => ({ sendNewDeviceEmail: mockSendEmail }));
vi.mock("@/lib/security/device-label", () => ({
  describeUserAgentLabel: (ua: string | null) => ua ?? "Unknown device",
}));
// Mock only the logger we depend on so the test doesn't pull the DB client
// (and the rest of login-risk) into the unit env.
vi.mock("@/lib/security/login-risk", () => ({ logIpVerify: vi.fn() }));

import { newDeviceNotifyClaimKey } from "@/lib/redis-keys";
import {
  claimNewDeviceNotification,
  maybeNotifyNewDevice,
  NEW_DEVICE_NOTIFY_TTL_SECONDS,
} from "@/lib/security/new-device-notification";

type SetFn = (...args: unknown[]) => Promise<unknown>;
function redisWithSet(set: SetFn): { set: SetFn } {
  return { set };
}

beforeEach(() => {
  mockGetRedis.mockReset();
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue(true);
});

describe("newDeviceNotifyClaimKey", () => {
  it("namespaces under deployment prefix + device-notify with user and device id", () => {
    // REDIS_KEY_PREFIX is unset in tests, so the prefix falls back to "local".
    expect(newDeviceNotifyClaimKey("u1", "dev-1")).toBe(
      "local:device-notify:u1:dev-1"
    );
  });
});

describe("claimNewDeviceNotification", () => {
  it("returns false (skip) when no Redis is configured", async () => {
    mockGetRedis.mockReturnValue(null);
    await expect(claimNewDeviceNotification("u1", "dev-1")).resolves.toBe(
      false
    );
  });

  it("returns true and claims with NX + EX TTL when the key was set", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    mockGetRedis.mockReturnValue(redisWithSet(set));

    await expect(claimNewDeviceNotification("u1", "dev-1")).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(
      "local:device-notify:u1:dev-1",
      "1",
      "EX",
      NEW_DEVICE_NOTIFY_TTL_SECONDS,
      "NX"
    );
  });

  it("returns false (skip) when another replica already holds the key", async () => {
    mockGetRedis.mockReturnValue(redisWithSet(vi.fn().mockResolvedValue(null)));
    await expect(claimNewDeviceNotification("u1", "dev-1")).resolves.toBe(
      false
    );
  });

  it("returns false (skip) when the Redis command throws", async () => {
    mockGetRedis.mockReturnValue(
      redisWithSet(vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))
    );
    await expect(claimNewDeviceNotification("u1", "dev-1")).resolves.toBe(
      false
    );
  });
});

describe("maybeNotifyNewDevice", () => {
  it("sends once when the claim is won, with the resolved device label", async () => {
    mockGetRedis.mockReturnValue(redisWithSet(vi.fn().mockResolvedValue("OK")));
    maybeNotifyNewDevice({
      userId: "u1",
      email: "a@b.com",
      deviceId: "dev-1",
      ip: "9.9.9.9",
      country: "DE",
      userAgent: "Mozilla/5.0",
    });

    await vi.waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "a@b.com",
        ip: "9.9.9.9",
        country: "DE",
        device: "Mozilla/5.0",
      })
    );
  });

  it("does not send when another replica already claimed", async () => {
    mockGetRedis.mockReturnValue(redisWithSet(vi.fn().mockResolvedValue(null)));

    maybeNotifyNewDevice({
      userId: "u1",
      email: "a@b.com",
      deviceId: "dev-1",
      ip: "9.9.9.9",
      country: null,
      userAgent: null,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("sends once across a fan-out: only the SET NX winner delivers", async () => {
    // SET NX is atomic in Redis: the first call sets the key ("OK"), the rest
    // see it exists (null). The mock mirrors that so concurrent sign-ins for
    // the same device produce exactly one email with no local dedup.
    const set = vi.fn().mockResolvedValueOnce("OK").mockResolvedValue(null);
    mockGetRedis.mockReturnValue(redisWithSet(set));
    const notification = {
      userId: "u1",
      email: "a@b.com",
      deviceId: "dev-1",
      ip: "9.9.9.9",
      country: null,
      userAgent: null,
    };

    maybeNotifyNewDevice(notification);
    maybeNotifyNewDevice(notification);
    maybeNotifyNewDevice(notification);

    await vi.waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledTimes(3);
  });

  it("skips entirely when userId or deviceId is empty", async () => {
    mockGetRedis.mockReturnValue(redisWithSet(vi.fn().mockResolvedValue("OK")));

    maybeNotifyNewDevice({
      userId: "",
      email: "a@b.com",
      deviceId: "dev-1",
      ip: "9.9.9.9",
      country: null,
      userAgent: null,
    });
    maybeNotifyNewDevice({
      userId: "u1",
      email: "a@b.com",
      deviceId: "",
      ip: "9.9.9.9",
      country: null,
      userAgent: null,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
