import type { AddressInfo, Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateDbMetrics = vi.fn();
const getDbMetrics = vi.fn();
const getPrometheusContentType = vi.fn();

// Mock the app's metrics module so the HTTP wiring is tested without a DB.
vi.mock("../lib/metrics/prometheus-api", () => ({
  updateDbMetrics: () => updateDbMetrics(),
  getDbMetrics: () => getDbMetrics(),
  getPrometheusContentType: () => getPrometheusContentType(),
}));

const { buildServer } = await import("./server");

describe("metrics-collector server (TECH-6484)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    updateDbMetrics.mockReset().mockResolvedValue(undefined);
    getDbMetrics.mockReset().mockResolvedValue("keeperhub_user_total 0\n");
    getPrometheusContentType
      .mockReset()
      .mockReturnValue("text/plain; version=0.0.4; charset=utf-8");

    server = buildServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("GET /metrics refreshes then serves the DB registry", async () => {
    const res = await fetch(`${baseUrl}/metrics`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("keeperhub_user_total");
    expect(updateDbMetrics).toHaveBeenCalledTimes(1);
    expect(getDbMetrics).toHaveBeenCalledTimes(1);
  });

  it("GET /health returns ok without touching the DB", async () => {
    const res = await fetch(`${baseUrl}/health`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("keeperhub-metrics-collector");
    expect(updateDbMetrics).not.toHaveBeenCalled();
  });

  it("returns 500 when the refresh throws", async () => {
    updateDbMetrics.mockRejectedValueOnce(new Error("db down"));

    const res = await fetch(`${baseUrl}/metrics`);

    expect(res.status).toBe(500);
  });

  it("404s unknown paths", async () => {
    const res = await fetch(`${baseUrl}/nope`);

    expect(res.status).toBe(404);
  });
});
