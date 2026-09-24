/**
 * Access control on the /api/metrics scrape endpoints.
 *
 * The series carry org_slug, plan and workflow_id labels, and the ingress
 * routes every path on app.keeperhub.com to the app pods, so the handlers
 * have to reject edge-originated requests themselves. Prometheus scrapes the
 * pod port directly and so arrives without any forwarding header.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authenticateInternalService = vi.fn();
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: (request: Request, rawBody?: string) =>
    authenticateInternalService(request, rawBody),
}));

const { authorizeMetricsScrape, EDGE_HEADERS, NEXT_SYNTHESIZED_HEADERS } =
  await import("@/lib/metrics/scrape-guard");

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://app.keeperhub.com/api/metrics", { headers });
}

beforeEach(() => {
  authenticateInternalService.mockReset();
});

describe("authorizeMetricsScrape", () => {
  it("allows a direct in-cluster scrape carrying no forwarding headers", async () => {
    await expect(authorizeMetricsScrape(request())).resolves.toEqual({
      allowed: true,
    });
  });

  it.each(["cf-connecting-ip", "cf-ray", "forwarded"])(
    "refuses a request forwarded by the edge (%s)",
    async (header) => {
      const result = await authorizeMetricsScrape(
        request({ [header]: "1.2.3.4" })
      );

      expect(result).toEqual({
        allowed: false,
        status: 404,
        message: "Not Found",
      });
    }
  );

  // The 2026-09-09 outage: matching on x-forwarded-* refused every scrape,
  // because Next.js fills those in from the socket when the client sent none.
  // A guard header must be one Next.js never invents.
  it("matches no header Next.js sets on its own", () => {
    const overlap = EDGE_HEADERS.filter((header) =>
      NEXT_SYNTHESIZED_HEADERS.includes(header)
    );

    expect(overlap).toEqual([]);
  });

  it.each(NEXT_SYNTHESIZED_HEADERS)(
    "allows an in-cluster scrape carrying %s, which Next.js adds itself",
    async (header) => {
      const result = await authorizeMetricsScrape(
        request({ [header]: "10.0.2.244" })
      );

      expect(result).toEqual({ allowed: true });
    }
  );

  it("allows a scrape carrying the full set Next.js synthesizes", async () => {
    const headers = Object.fromEntries(
      NEXT_SYNTHESIZED_HEADERS.map((header) => [header, "10.0.2.244"])
    );

    await expect(authorizeMetricsScrape(request(headers))).resolves.toEqual({
      allowed: true,
    });
  });

  it("does not reach the HMAC verifier for an unsigned edge request", async () => {
    await authorizeMetricsScrape(request({ "cf-connecting-ip": "1.2.3.4" }));

    expect(authenticateInternalService).not.toHaveBeenCalled();
  });

  it("allows a signed internal caller reaching the pod directly", async () => {
    authenticateInternalService.mockResolvedValue({
      authenticated: true,
      caller: "mcp",
      scheme: "hmac",
    });

    const result = await authorizeMetricsScrape(
      request({
        "x-kh-caller": "mcp",
        "x-kh-timestamp": "1700000000",
        "x-kh-signature": "a".repeat(64),
      })
    );

    expect(result).toEqual({ allowed: true });
  });

  // A caller header alone used to reach the verifier and come back 401, which
  // told a prober the route was real. From the edge the answer is 404 whether
  // the request is signed, half-signed or unsigned.
  it.each([
    ["unsigned", {}],
    ["a caller header only", { "x-kh-caller": "mcp" }],
    [
      "a full valid signature",
      {
        "x-kh-caller": "mcp",
        "x-kh-timestamp": "1700000000",
        "x-kh-signature": "a".repeat(64),
      },
    ],
  ])(
    "refuses an edge request with %s, without reaching the verifier",
    async (_label, headers) => {
      authenticateInternalService.mockResolvedValue({
        authenticated: true,
        caller: "mcp",
        scheme: "hmac",
      });

      const result = await authorizeMetricsScrape(
        request({ "cf-connecting-ip": "1.2.3.4", ...headers })
      );

      expect(result).toEqual({
        allowed: false,
        status: 404,
        message: "Not Found",
      });
      expect(authenticateInternalService).not.toHaveBeenCalled();
    }
  );

  it("propagates the verifier's rejection for a bad signature", async () => {
    authenticateInternalService.mockResolvedValue({
      authenticated: false,
      error: "Invalid signature",
      status: 401,
    });

    const result = await authorizeMetricsScrape(
      request({
        "x-kh-caller": "mcp",
        "x-kh-timestamp": "1700000000",
        "x-kh-signature": "b".repeat(64),
      })
    );

    expect(result).toEqual({
      allowed: false,
      status: 401,
      message: "Invalid signature",
    });
  });

  it("verifies a partial HMAC claim rather than treating it as unsigned", async () => {
    authenticateInternalService.mockResolvedValue({
      authenticated: false,
      error: "Missing HMAC headers",
      status: 401,
    });

    const result = await authorizeMetricsScrape(
      request({ "x-kh-caller": "mcp" })
    );

    expect(authenticateInternalService).toHaveBeenCalledOnce();
    expect(result).toEqual({
      allowed: false,
      status: 401,
      message: "Missing HMAC headers",
    });
  });
});

describe("metrics route handlers", () => {
  // A new route added under app/api/metrics that forgets the guard would be
  // publicly readable, so assert the wiring rather than only the helper.
  it.each([
    "app/api/metrics/route.ts",
    "app/api/metrics/api/route.ts",
    "app/api/metrics/db/route.ts",
  ])("%s applies the scrape guard", (routePath) => {
    const source = readFileSync(join(process.cwd(), routePath), "utf8");

    expect(source).toContain("authorizeMetricsScrape");
    expect(source).toMatch(/GET\(request: Request\)/);
  });

  it.each([
    ["@/app/api/metrics/route", "/api/metrics"],
    ["@/app/api/metrics/api/route", "/api/metrics/api"],
    ["@/app/api/metrics/db/route", "/api/metrics/db"],
  ])("%s answers 404 to an edge request", async (module, path) => {
    vi.stubEnv("METRICS_COLLECTOR", "prometheus");
    vi.stubEnv("METRICS_DB_OFFLOADED", "");

    const { GET } = await import(module);
    const response = await GET(
      new Request(`https://app.keeperhub.com${path}`, {
        headers: { "cf-connecting-ip": "1.2.3.4" },
      })
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");

    vi.unstubAllEnvs();
  });
});
