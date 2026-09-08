import { describe, expect, it, vi } from "vitest";

// tempo-step-helpers pulls server/db/rpc deps for its other exports; parseTimestamp
// itself is pure, so stub the module's heavy imports and exercise the real function.
vi.mock("server-only", () => ({}));
vi.mock("drizzle-orm", () => ({ and: () => ({}), eq: () => ({}) }));
vi.mock("ethers", () => ({
  ethers: {
    Interface: class {},
    Contract: class {},
    isAddress: () => false,
    getAddress: (address: string) => address,
  },
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({
  explorerConfigs: {},
  supportedTokens: {},
}));
vi.mock("@/lib/explorer", () => ({ getTransactionUrl: () => "" }));
vi.mock("@/plugins/tempo/steps/tempo-tx-core", () => ({
  isTempoChain: () => true,
  TEMPO_STABLECOIN_DEX: {},
}));

import { parseTimestamp } from "@/plugins/tempo/steps/tempo-step-helpers";

const NOW = 1_800_000_000;
const HOUR = 3600;
const MINUTE = 60;
const DAY = 86_400;

describe("parseTimestamp", () => {
  it("returns undefined for blank input", () => {
    expect(parseTimestamp(undefined, NOW)).toBeUndefined();
    expect(parseTimestamp("", NOW)).toBeUndefined();
    expect(parseTimestamp("   ", NOW)).toBeUndefined();
  });

  it("parses unix seconds and downshifts millisecond values", () => {
    expect(parseTimestamp("1800000000", NOW)).toBe(NOW);
    expect(parseTimestamp("1800000000000", NOW)).toBe(NOW);
  });

  it("parses an absolute ISO datetime", () => {
    const iso = "2027-01-15T12:00:00Z";
    expect(parseTimestamp(iso, NOW)).toBe(Math.floor(Date.parse(iso) / 1000));
  });

  it("resolves relative offsets against nowSec", () => {
    expect(parseTimestamp("+2h", NOW)).toBe(NOW + 2 * HOUR);
    expect(parseTimestamp("+30m", NOW)).toBe(NOW + 30 * MINUTE);
    expect(parseTimestamp("+7d", NOW)).toBe(NOW + 7 * DAY);
    expect(parseTimestamp("now+1h", NOW)).toBe(NOW + HOUR);
  });

  it("accepts a relative offset at the one-year ceiling", () => {
    expect(parseTimestamp("+366d", NOW)).toBe(NOW + 366 * DAY);
  });

  it("throws on a relative offset beyond one year", () => {
    expect(() => parseTimestamp("+99999d", NOW)).toThrow(/within one year/);
  });

  it("throws on an unparseable value", () => {
    expect(() => parseTimestamp("not-a-date", NOW)).toThrow();
  });
});
