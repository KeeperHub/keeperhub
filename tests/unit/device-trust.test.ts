import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLimit, mockInsert, mockNotify } = vi.hoisted(() => ({
  mockLimit: vi.fn(),
  mockInsert: vi.fn(),
  mockNotify: vi.fn(),
}));

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
vi.mock("@/lib/security/new-device-notification", () => ({
  maybeNotifyNewDevice: mockNotify,
}));
// Avoid pulling the full login-risk module (DB client, headers) into the unit.
vi.mock("@/lib/security/login-risk", () => ({
  resolveClientIpFromHeaders: (h: { get: (k: string) => string | null }) =>
    h.get("cf-connecting-ip"),
}));

import { deviceCookieName } from "@/lib/device-cookie";
import { resolveSigninDevice } from "@/lib/security/device-trust";

function requestWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/", { headers });
}

beforeEach(() => {
  mockLimit.mockReset();
  mockInsert.mockReset();
  mockNotify.mockReset();
  mockInsert.mockResolvedValue(undefined);
  vi.stubEnv("BETTER_AUTH_SECRET", "unit-secret");
});

describe("resolveSigninDevice", () => {
  it("emails and records when the device is new and not the first", async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "old" }]);

    const setCookie = await resolveSigninDevice({
      userId: "u1",
      email: "a@b.com",
      country: "DE",
      request: requestWith({
        "user-agent": "Mozilla/5.0",
        "cf-connecting-ip": "9.9.9.9",
      }),
    });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        email: "a@b.com",
        country: "DE",
        ip: "9.9.9.9",
        userAgent: "Mozilla/5.0",
      })
    );
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(setCookie).toContain(`${deviceCookieName()}=`);
  });

  it("does not email the account's first-ever device", async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const setCookie = await resolveSigninDevice({
      userId: "u1",
      email: "a@b.com",
      country: null,
      request: requestWith({ "user-agent": "Mozilla/5.0" }),
    });

    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(setCookie).toContain(`${deviceCookieName()}=`);
  });

  it("does not email a known device", async () => {
    mockLimit.mockResolvedValueOnce([{ id: "known" }]);

    await resolveSigninDevice({
      userId: "u1",
      email: "a@b.com",
      country: "DE",
      request: requestWith({ "user-agent": "Mozilla/5.0" }),
    });

    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("skips device tracking when the server secret is missing", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    const setCookie = await resolveSigninDevice({
      userId: "u1",
      email: "a@b.com",
      country: "DE",
      request: requestWith({ "user-agent": "Mozilla/5.0" }),
    });
    expect(setCookie).toBeNull();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
