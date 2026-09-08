import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockReturning, mockWhere, mockSelectWhere } = vi.hoisted(() => ({
  mockReturning: vi.fn(),
  mockWhere: vi.fn(),
  mockSelectWhere: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    update: () => ({
      set: () => ({ where: mockWhere }),
    }),
    select: () => ({
      from: () => ({ where: mockSelectWhere }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  users: { id: "id", signupNotifiedAt: "signupNotifiedAt" },
  accounts: { userId: "userId", providerId: "providerId" },
}));

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  eq: () => ({}),
  isNull: () => ({}),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

import {
  claimSignupNotification,
  resolveSignupMethod,
} from "@/lib/auth-signup-notification";

beforeEach(() => {
  vi.clearAllMocks();
  mockWhere.mockReturnValue({ returning: mockReturning });
});

describe("claimSignupNotification", () => {
  it("grants the claim when the account has not been announced", async () => {
    mockReturning.mockResolvedValue([{ id: "user-1" }]);
    expect(await claimSignupNotification("user-1")).toBe(true);
  });

  it("refuses a second claim, so a re-verification cannot re-announce", async () => {
    mockReturning.mockResolvedValueOnce([{ id: "user-1" }]);
    expect(await claimSignupNotification("user-1")).toBe(true);

    // The conditional update matches nothing once signup_notified_at is set.
    mockReturning.mockResolvedValueOnce([]);
    expect(await claimSignupNotification("user-1")).toBe(false);
  });

  it("fails closed when the write throws", async () => {
    mockReturning.mockRejectedValue(new Error("connection reset"));
    expect(await claimSignupNotification("user-1")).toBe(false);
  });
});

describe("resolveSignupMethod", () => {
  it("names the OAuth provider rather than guessing from an avatar", async () => {
    mockSelectWhere.mockResolvedValue([{ providerId: "github" }]);
    expect(await resolveSignupMethod("user-1", "OAuth")).toBe("GitHub");
  });

  it("reports Email for a credential account", async () => {
    mockSelectWhere.mockResolvedValue([{ providerId: "credential" }]);
    expect(await resolveSignupMethod("user-1", "OAuth")).toBe("Email");
  });

  it("reports Wallet for a SIWE account", async () => {
    mockSelectWhere.mockResolvedValue([{ providerId: "siwe" }]);
    expect(await resolveSignupMethod("user-1", "Email")).toBe("Wallet");
  });

  it("falls back when the account row is not written yet", async () => {
    mockSelectWhere.mockResolvedValue([]);
    expect(await resolveSignupMethod("user-1", "OAuth")).toBe("OAuth");
  });

  it("falls back when the lookup throws", async () => {
    mockSelectWhere.mockRejectedValue(new Error("connection reset"));
    expect(await resolveSignupMethod("user-1", "Email")).toBe("Email");
  });
});
