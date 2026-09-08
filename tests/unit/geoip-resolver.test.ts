import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLatLon } from "@/lib/security/geoip/types";
import { resolveLocationFromIp } from "@/lib/security/resolve-country";

type JsonResponder = (url: string) => {
  ok: boolean;
  body: Record<string, unknown>;
};

// Match on the exact hostname rather than a substring of the URL. A
// substring check (`url.includes("ipapi.co")`) both trips CodeQL's
// incomplete-URL-sanitization rule and collides on overlapping hosts
// (freeipapi.com contains "ipapi.co").
function hostIs(url: string, host: string): boolean {
  try {
    return new URL(url).hostname === host;
  } catch {
    return false;
  }
}

function stubFetch(responder: JsonResponder): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string) => {
      const { ok, body } = responder(input);
      return Promise.resolve({
        ok,
        json: () => Promise.resolve(body),
      } as Response);
    })
  );
}

// Each test uses a distinct IP so the resolver's 24h per-IP cache never
// returns a value seeded by a previous test.
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

beforeEach(() => {
  delete process.env.IPINFO_TOKEN;
  delete process.env.IPAPI_KEY;
  delete process.env.GEOIP_ENABLED;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEOIP_ENABLED;
});

describe("parseLatLon", () => {
  it("parses numeric and string coordinates", () => {
    expect(parseLatLon(37.42, -122.08)).toEqual({
      latitude: 37.42,
      longitude: -122.08,
    });
    expect(parseLatLon("51.5074", "-0.1278")).toEqual({
      latitude: 51.5074,
      longitude: -0.1278,
    });
  });

  it("rejects null-island (0,0) as a no-fix sentinel", () => {
    expect(parseLatLon(0, 0)).toEqual({ latitude: null, longitude: null });
  });

  it("rejects out-of-range and non-finite values", () => {
    expect(parseLatLon(91, 0)).toEqual({ latitude: null, longitude: null });
    expect(parseLatLon(10, 181)).toEqual({ latitude: null, longitude: null });
    expect(parseLatLon("nope", 10)).toEqual({
      latitude: null,
      longitude: null,
    });
  });

  it("keeps a real value paired with a genuine zero on the other axis", () => {
    expect(parseLatLon(51.5, 0)).toEqual({ latitude: 51.5, longitude: 0 });
  });
});

describe("resolveLocationFromIp provider chain", () => {
  it("returns null location for a null IP without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await resolveLocationFromIp(null);
    expect(result.country).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves country + coordinates from ipapi.co (the keyless primary)", async () => {
    stubFetch((url) => {
      if (hostIs(url, "ipapi.co")) {
        return {
          ok: true,
          body: {
            country_code: "us",
            region_code: "CA",
            city: "Mountain View",
            latitude: 37.42,
            longitude: -122.08,
          },
        };
      }
      return { ok: false, body: {} };
    });
    const result = await resolveLocationFromIp(uniqueIp());
    expect(result).toEqual({
      country: "US",
      region: "CA",
      city: "Mountain View",
      latitude: 37.42,
      longitude: -122.08,
    });
  });

  it("falls through to ipwho.is when ipapi.co rate-limits (error body)", async () => {
    stubFetch((url) => {
      if (hostIs(url, "ipapi.co")) {
        return { ok: true, body: { error: true, reason: "RateLimited" } };
      }
      if (hostIs(url, "ipwho.is")) {
        return {
          ok: true,
          body: {
            success: true,
            country_code: "GB",
            region: "England",
            city: "London",
            latitude: 51.5074,
            longitude: -0.1278,
          },
        };
      }
      return { ok: false, body: {} };
    });
    const result = await resolveLocationFromIp(uniqueIp());
    expect(result.country).toBe("GB");
    expect(result.city).toBe("London");
    expect(result.latitude).toBeCloseTo(51.5074);
  });

  it("falls through to freeipapi when both ipapi.co and ipwho.is miss", async () => {
    stubFetch((url) => {
      if (hostIs(url, "freeipapi.com")) {
        return {
          ok: true,
          body: {
            countryCode: "DE",
            regionName: "Berlin",
            cityName: "Berlin",
            latitude: 52.52,
            longitude: 13.405,
          },
        };
      }
      if (hostIs(url, "ipapi.co")) {
        return { ok: false, body: {} };
      }
      if (hostIs(url, "ipwho.is")) {
        return { ok: true, body: { success: false } };
      }
      return { ok: false, body: {} };
    });
    const result = await resolveLocationFromIp(uniqueIp());
    expect(result.country).toBe("DE");
    expect(result.city).toBe("Berlin");
  });

  it("returns null location when every provider misses", async () => {
    stubFetch(() => ({ ok: false, body: {} }));
    const result = await resolveLocationFromIp(uniqueIp());
    expect(result).toEqual({
      country: null,
      region: null,
      city: null,
      latitude: null,
      longitude: null,
    });
  });

  it("prefers ipinfo.io and parses its loc string when IPINFO_TOKEN is set", async () => {
    process.env.IPINFO_TOKEN = "test-token";
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (hostIs(url, "ipinfo.io")) {
        return {
          ok: true,
          body: {
            country: "FR",
            region: "Ile-de-France",
            city: "Paris",
            loc: "48.8566,2.3522",
          },
        };
      }
      return { ok: false, body: {} };
    });
    const result = await resolveLocationFromIp(uniqueIp());
    expect(result.country).toBe("FR");
    expect(result.latitude).toBeCloseTo(48.8566);
    expect(result.longitude).toBeCloseTo(2.3522);
    // ipinfo answered first, so the chain never reached the keyless tier.
    expect(seen.some((u) => hostIs(u, "ipinfo.io"))).toBe(true);
    expect(seen.some((u) => hostIs(u, "ipapi.co"))).toBe(false);
  });

  it("skips ipinfo.io entirely when no token is configured", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (hostIs(url, "ipapi.co")) {
        return {
          ok: true,
          body: { country_code: "US", latitude: 1, longitude: 1 },
        };
      }
      return { ok: false, body: {} };
    });
    await resolveLocationFromIp(uniqueIp());
    expect(seen.some((u) => hostIs(u, "ipinfo.io"))).toBe(false);
  });
});

describe("GEOIP_ENABLED", () => {
  // The whole point of the switch. Every provider in the chain is keyless, so
  // "configured nothing" is not the same as "sends nothing" without this.
  it("makes no request at all when disabled", async () => {
    process.env.GEOIP_ENABLED = "false";
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return { ok: true, body: { country_code: "US" } };
    });
    const location = await resolveLocationFromIp(uniqueIp());
    expect(seen).toEqual([]);
    expect(location).toEqual({
      country: null,
      region: null,
      city: null,
      latitude: null,
      longitude: null,
    });
  });

  // Unset must reproduce today exactly, which is the production invariant for
  // this whole branch.
  it("resolves normally when unset", async () => {
    stubFetch((url) =>
      hostIs(url, "ipapi.co")
        ? { ok: true, body: { country_code: "US", city: "Reno" } }
        : { ok: false, body: {} }
    );
    const location = await resolveLocationFromIp(uniqueIp());
    expect(location.country).toBe("US");
    expect(location.city).toBe("Reno");
  });

  // A gate that switches off on any truthy value gets switched off by accident.
  it("treats values other than the literal false as enabled", async () => {
    process.env.GEOIP_ENABLED = "true";
    stubFetch((url) =>
      hostIs(url, "ipapi.co")
        ? { ok: true, body: { country_code: "DE" } }
        : { ok: false, body: {} }
    );
    expect((await resolveLocationFromIp(uniqueIp())).country).toBe("DE");

    process.env.GEOIP_ENABLED = "0";
    expect((await resolveLocationFromIp(uniqueIp())).country).toBe("DE");
  });
});
