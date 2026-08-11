import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockHeaders, mockLimit } = vi.hoisted(() => ({
  mockHeaders: vi.fn(),
  mockLimit: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mockHeaders }));
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: mockLimit }) }),
    }),
  },
}));

import { assessCountryTrust } from "@/lib/security/login-risk";

function headersWith(values: Record<string, string>): {
  get: (key: string) => string | null;
} {
  return { get: (key: string) => values[key.toLowerCase()] ?? null };
}

const CF_HEADERS = { "cf-connecting-ip": "9.9.9.9", "cf-ipcountry": "DE" };

beforeEach(() => {
  mockHeaders.mockReset();
  mockLimit.mockReset();
  mockHeaders.mockResolvedValue(headersWith(CF_HEADERS));
});

describe("assessCountryTrust", () => {
  it("trusts (no_cf) when CF did not attest a country, without DB reads", async () => {
    mockHeaders.mockResolvedValue(
      headersWith({ "cf-connecting-ip": "9.9.9.9" })
    );
    expect(await assessCountryTrust("u1")).toEqual({
      country: null,
      ip: "9.9.9.9",
      trusted: true,
      reason: "no_cf",
    });
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it("trusts a known country", async () => {
    mockLimit.mockResolvedValueOnce([{ id: "row-1" }]);
    expect(await assessCountryTrust("u1")).toEqual({
      country: "DE",
      ip: "9.9.9.9",
      trusted: true,
      reason: "known",
    });
  });

  it("auto-trusts the first-ever attestation", async () => {
    mockLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await assessCountryTrust("u1")).toEqual({
      country: "DE",
      ip: "9.9.9.9",
      trusted: true,
      reason: "first",
    });
  });

  it("flags a new country untrusted when prior countries exist and no legacy IP", async () => {
    // Country miss, prior countries exist, legacy-IP miss.
    mockLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "prior" }])
      .mockResolvedValueOnce([]);
    expect(await assessCountryTrust("u1")).toEqual({
      country: "DE",
      ip: "9.9.9.9",
      trusted: false,
      reason: "untrusted",
    });
  });

  it("bridges a legacy trusted IP for an unfamiliar country", async () => {
    // Country miss, prior countries exist, legacy user_trusted_ips hit.
    mockLimit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "prior" }])
      .mockResolvedValueOnce([{ id: "legacy-ip" }]);
    expect(await assessCountryTrust("u1")).toEqual({
      country: "DE",
      ip: "9.9.9.9",
      trusted: true,
      reason: "legacy_ip",
    });
  });
});
