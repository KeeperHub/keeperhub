import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHeaders = vi.fn();
const mockSelect = vi.fn();
const mockResolveLocationFromIp = vi.fn();

vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

// Mock the IP-to-location resolver so location (including coordinates) is
// deterministic in tests instead of depending on a live provider lookup.
// The CF path still overrides the country with CF-IPCountry; region, city,
// and coordinates come from here.
vi.mock("@/lib/security/resolve-country", () => ({
  resolveLocationFromIp: (...args: unknown[]) =>
    mockResolveLocationFromIp(...args),
}));

function setHeaders(values: Record<string, string | null>): void {
  const map = new Map<string, string | null>(
    Object.entries(values).map(([k, v]) => [k.toLowerCase(), v])
  );
  mockHeaders.mockResolvedValueOnce({
    get: (name: string) => map.get(name.toLowerCase()) ?? null,
  });
}

function setRecentSessionCountries(countries: (string | null)[]): void {
  const recentRows = countries.map((country) =>
    country === null
      ? { riskFlagsJson: null }
      : { riskFlagsJson: JSON.stringify({ country }) }
  );
  mockSelect.mockReturnValueOnce({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(recentRows),
        }),
      }),
    }),
  });
}

type LocatedRow = {
  latitude: number;
  longitude: number;
  createdAtMsAgo: number;
};

// Second select in assessLoginRisk: loadMostRecentLocatedSession. Only
// queried when the current login resolved coordinates.
function setMostRecentLocatedSession(row: LocatedRow | null): void {
  const rows = row
    ? [
        {
          riskFlagsJson: JSON.stringify({
            latitude: row.latitude,
            longitude: row.longitude,
          }),
          createdAt: new Date(Date.now() - row.createdAtMsAgo),
        },
      ]
    : [];
  mockSelect.mockReturnValueOnce({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  });
}

import { assessLoginRisk, serializeRiskFlags } from "@/lib/security/login-risk";

const NO_LOCATION = {
  country: null,
  region: null,
  city: null,
  latitude: null,
  longitude: null,
};

beforeEach(() => {
  mockHeaders.mockReset();
  mockSelect.mockReset();
  mockResolveLocationFromIp.mockReset();
  mockResolveLocationFromIp.mockResolvedValue(NO_LOCATION);
});

describe("assessLoginRisk", () => {
  it("stays inconclusive when CF-Connecting-IP is absent and there is no country history (local dev / direct origin)", async () => {
    setHeaders({ "cf-ipcountry": "AU" });
    setRecentSessionCountries([]);
    const result = await assessLoginRisk("user_1");
    expect(result).toEqual({
      anomaly: false,
      reasons: [],
      country: null,
      region: null,
      city: null,
      latitude: null,
      longitude: null,
      recentCountries: [],
    });
  });

  it("stays inconclusive when CF-IPCountry is missing and there is no country history", async () => {
    setHeaders({ "cf-connecting-ip": "203.0.113.1" });
    setRecentSessionCountries([null, null]);
    const result = await assessLoginRisk("user_1");
    expect(result.country).toBeNull();
    expect(result.anomaly).toBe(false);
  });

  it("stays inconclusive when CF-IPCountry is the unknown sentinel XX and there is no country history", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "XX",
    });
    setRecentSessionCountries([]);
    const result = await assessLoginRisk("user_1");
    expect(result.country).toBeNull();
    expect(result.anomaly).toBe(false);
  });

  it("flags unknown_country when a login with no attested country follows a known-country history", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "XX",
    });
    setRecentSessionCountries(["AU", "AU"]);
    const result = await assessLoginRisk("user_1");
    expect(result.country).toBeNull();
    expect(result.anomaly).toBe(true);
    expect(result.reasons).toEqual(["unknown_country"]);
    expect(result.recentCountries).toEqual(["AU"]);
  });

  it("flags unknown_country when CF is bypassed entirely for a user with country history", async () => {
    setHeaders({ "cf-ipcountry": "AU" });
    setRecentSessionCountries(["KR"]);
    const result = await assessLoginRisk("user_1");
    expect(result.country).toBeNull();
    expect(result.anomaly).toBe(true);
    expect(result.reasons).toEqual(["unknown_country"]);
    expect(result.recentCountries).toEqual(["KR"]);
  });

  it("flags first_geo_attestation (not anomaly) for a user's first geo-attested session", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "au",
    });
    setRecentSessionCountries([null, null]);
    const result = await assessLoginRisk("user_1");
    expect(result.country).toBe("AU");
    expect(result.anomaly).toBe(false);
    expect(result.reasons).toEqual(["first_geo_attestation"]);
  });

  it("does not flag when login country matches a prior session country", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "AU",
    });
    setRecentSessionCountries(["AU", "AU"]);
    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(false);
    expect(result.country).toBe("AU");
  });

  it("flags new_country when login country differs from every recent country", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "KR",
    });
    setRecentSessionCountries(["AU", "AU"]);
    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(true);
    expect(result.reasons).toEqual(["new_country"]);
    expect(result.country).toBe("KR");
    expect(result.recentCountries).toEqual(["AU"]);
  });

  it("treats null-only history (pre-tracking sessions) as first_geo_attestation", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "KR",
    });
    setRecentSessionCountries([null, null, null]);
    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(false);
    expect(result.reasons).toEqual(["first_geo_attestation"]);
  });

  it("ignores the current country from the recent-countries list when reporting history", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "AU",
    });
    setRecentSessionCountries(["AU", "US"]);
    const result = await assessLoginRisk("user_1");
    expect(result.recentCountries).toEqual(["US"]);
    expect(result.anomaly).toBe(false);
  });

  it("tolerates malformed risk_flags_json rows without throwing", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "KR",
    });
    mockSelect.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () =>
              Promise.resolve([
                { riskFlagsJson: "not json" },
                { riskFlagsJson: JSON.stringify({ country: "AU" }) },
              ]),
          }),
        }),
      }),
    });

    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(true);
    expect(result.recentCountries).toEqual(["AU"]);
  });
});

describe("assessLoginRisk impossible-travel", () => {
  // Sydney and London are ~17,000 km apart: implausible in one hour,
  // trivial over a fortnight.
  const SYDNEY = { latitude: -33.8688, longitude: 151.2093 };
  const LONDON = { latitude: 51.5074, longitude: -0.1278 };

  function loginFrom(coords: { latitude: number; longitude: number }): void {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "AU",
    });
    mockResolveLocationFromIp.mockResolvedValue({
      country: "AU",
      region: null,
      city: null,
      latitude: coords.latitude,
      longitude: coords.longitude,
    });
  }

  it("flags impossible_travel for a far hop in too little time, even in a known country", async () => {
    loginFrom(SYDNEY);
    setRecentSessionCountries(["AU"]);
    setMostRecentLocatedSession({
      ...LONDON,
      createdAtMsAgo: 60 * 60 * 1000,
    });
    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(true);
    expect(result.reasons).toContain("impossible_travel");
    expect(result.reasons).not.toContain("new_country");
  });

  it("does not flag when the same distance is covered over enough time", async () => {
    loginFrom(SYDNEY);
    setRecentSessionCountries(["AU"]);
    setMostRecentLocatedSession({
      ...LONDON,
      createdAtMsAgo: 14 * 24 * 60 * 60 * 1000,
    });
    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(false);
    expect(result.reasons).not.toContain("impossible_travel");
  });

  it("does not flag short same-city hops as travel (geo-IP jitter)", async () => {
    loginFrom(SYDNEY);
    setRecentSessionCountries(["AU"]);
    setMostRecentLocatedSession({
      latitude: SYDNEY.latitude + 0.05,
      longitude: SYDNEY.longitude + 0.05,
      createdAtMsAgo: 60 * 1000,
    });
    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(false);
    expect(result.reasons).not.toContain("impossible_travel");
  });

  it("stacks new_country and impossible_travel when both fire", async () => {
    setHeaders({
      "cf-connecting-ip": "203.0.113.1",
      "cf-ipcountry": "AU",
    });
    mockResolveLocationFromIp.mockResolvedValue({
      country: "AU",
      region: null,
      city: null,
      ...SYDNEY,
    });
    setRecentSessionCountries(["GB"]);
    setMostRecentLocatedSession({ ...LONDON, createdAtMsAgo: 60 * 60 * 1000 });
    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["new_country", "impossible_travel"])
    );
  });

  it("stays silent when there is no prior located session to compare against", async () => {
    loginFrom(SYDNEY);
    setRecentSessionCountries(["AU"]);
    setMostRecentLocatedSession(null);
    const result = await assessLoginRisk("user_1");
    expect(result.anomaly).toBe(false);
    expect(result.reasons).not.toContain("impossible_travel");
  });
});

describe("serializeRiskFlags", () => {
  it("round-trips through JSON without losing fields", () => {
    const signal = {
      anomaly: true,
      reasons: ["new_country"] as const,
      country: "KR",
      region: "11",
      city: "Seoul",
      latitude: 37.5665,
      longitude: 126.978,
      recentCountries: ["AU"] as const,
    };
    const serialized = serializeRiskFlags(signal);
    expect(JSON.parse(serialized)).toEqual({
      anomaly: true,
      reasons: ["new_country"],
      country: "KR",
      region: "11",
      city: "Seoul",
      latitude: 37.5665,
      longitude: 126.978,
      recentCountries: ["AU"],
    });
  });
});
