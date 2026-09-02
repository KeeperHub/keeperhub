import { describe, expect, it } from "vitest";
import { parseRunFilters } from "@/lib/analytics/parse-run-filters";
import { buildRunsQuery } from "@/lib/analytics/runs-query";

function parse(query: string): ReturnType<typeof parseRunFilters> {
  return parseRunFilters(new URLSearchParams(query));
}

describe("parseRunFilters", () => {
  it("reads every value of a repeated dimension", () => {
    expect(
      parse("status=error&status=external_error&status=system_error").statuses
    ).toEqual(["error", "external_error", "system_error"]);
  });

  it("keeps a single value working the way it always did", () => {
    expect(parse("status=success").statuses).toEqual(["success"]);
  });

  it("drops unknown statuses and sources rather than narrowing on them", () => {
    expect(parse("status=bogus&source=telepathy").statuses).toBeUndefined();
    expect(parse("status=bogus&source=telepathy").sources).toBeUndefined();
  });

  it("de-duplicates repeated values", () => {
    expect(parse("network=8453&network=8453").networks).toEqual(["8453"]);
  });

  it("ignores a negative or non-numeric duration bound", () => {
    expect(parse("durationMin=-5").durationMinMs).toBeUndefined();
    expect(parse("durationMax=soon").durationMaxMs).toBeUndefined();
    expect(parse("durationMin=30000").durationMinMs).toBe(30_000);
  });

  it("reads the gas dimension", () => {
    expect(parse("gas=sponsored").gas).toEqual(["sponsored"]);
    expect(parse("gas=wallet&gas=free").gas).toEqual(["wallet", "free"]);
    expect(parse("gas=maybe").gas).toBeUndefined();
  });

  it("trims search and caps its length", () => {
    expect(parse("search=%20%20nightly%20%20").search).toBe("nightly");
    expect(parse(`search=${"a".repeat(500)}`).search).toHaveLength(128);
  });
});

describe("buildRunsQuery", () => {
  it("round-trips through the parser", () => {
    const query = buildRunsQuery({
      range: "7d",
      statuses: ["error", "system_error"],
      sources: ["workflow"],
      networks: ["8453", "42161"],
      duration: "over30s",
      gas: ["wallet"],
      search: "nightly",
    });

    const parsed = parse(query);
    expect(parsed.gas).toEqual(["wallet"]);
    expect(parsed.statuses).toEqual(["error", "system_error"]);
    expect(parsed.sources).toEqual(["workflow"]);
    expect(parsed.networks).toEqual(["8453", "42161"]);
    expect(parsed.durationMinMs).toBe(30_000);
    expect(parsed.durationMaxMs).toBeUndefined();
    expect(parsed.search).toBe("nightly");
  });

  it("omits the status dimension for the facet request", () => {
    const query = buildRunsQuery({
      range: "24h",
      statuses: ["error"],
      networks: ["8453"],
      omitStatus: true,
    });

    expect(parse(query).statuses).toBeUndefined();
    // Every other dimension still applies, so a count sits under them.
    expect(parse(query).networks).toEqual(["8453"]);
  });

  it("carries a custom window so the picked dates reach the server", () => {
    const query = buildRunsQuery({
      range: "custom",
      customStart: "2026-08-01T00:00:00.000Z",
      customEnd: "2026-08-31T23:59:59.999Z",
    });
    const params = new URLSearchParams(query);
    expect(params.get("range")).toBe("custom");
    expect(params.get("customStart")).toBe("2026-08-01T00:00:00.000Z");
    expect(params.get("customEnd")).toBe("2026-08-31T23:59:59.999Z");
  });

  it("omits the window on a preset range", () => {
    const params = new URLSearchParams(buildRunsQuery({ range: "7d" }));
    expect(params.get("customStart")).toBeNull();
    expect(params.get("customEnd")).toBeNull();
  });

  it("leaves page 1 off the query so the first page has a clean URL", () => {
    expect(buildRunsQuery({ range: "24h", page: 1 })).toBe("range=24h");
    expect(buildRunsQuery({ range: "24h", page: 3 })).toContain("page=3");
  });
});
