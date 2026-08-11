import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const collectCounterDeltasMock = vi.fn();

vi.mock("./metrics-shipping", () => ({
  collectCounterDeltas: collectCounterDeltasMock,
}));

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  collectCounterDeltasMock.mockReset();
  fetchMock.mockReset();
  delete process.env.METRICS_COLLECTOR;
  delete process.env.EXECUTOR_METRICS_INGEST_URL;
  delete process.env.METRICS_INGEST_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const { shipMetricsToExecutor } = await import("./ship-metrics");

describe("shipMetricsToExecutor", () => {
  it("is a no-op when METRICS_COLLECTOR is not prometheus", async () => {
    await shipMetricsToExecutor();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(collectCounterDeltasMock).not.toHaveBeenCalled();
  });

  it("is a no-op when EXECUTOR_METRICS_INGEST_URL is unset", async () => {
    process.env.METRICS_COLLECTOR = "prometheus";
    await shipMetricsToExecutor();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips posting when there are no deltas", async () => {
    process.env.METRICS_COLLECTOR = "prometheus";
    process.env.EXECUTOR_METRICS_INGEST_URL = "http://executor:3080";
    collectCounterDeltasMock.mockResolvedValue([]);

    await shipMetricsToExecutor();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to /metrics/ingest, stripping a trailing slash from the base URL", async () => {
    process.env.METRICS_COLLECTOR = "prometheus";
    process.env.EXECUTOR_METRICS_INGEST_URL = "http://executor:3080/";
    process.env.METRICS_INGEST_TOKEN = "secret-token";
    collectCounterDeltasMock.mockResolvedValue([
      {
        name: "keeperhub_rpc_primary_attempts_total",
        labels: { chain: "ethereum", operation: "read" },
        value: 2,
      },
    ]);
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });

    await shipMetricsToExecutor();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://executor:3080/metrics/ingest");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Ingest-Token"]).toBe("secret-token");
    const parsed = JSON.parse(init.body);
    expect(parsed.deltas).toHaveLength(1);
    expect(parsed.deltas[0].name).toBe("keeperhub_rpc_primary_attempts_total");
  });

  it("swallows network errors", async () => {
    process.env.METRICS_COLLECTOR = "prometheus";
    process.env.EXECUTOR_METRICS_INGEST_URL = "http://executor:3080";
    collectCounterDeltasMock.mockResolvedValue([
      {
        name: "keeperhub_rpc_primary_attempts_total",
        labels: { chain: "ethereum", operation: "read" },
        value: 1,
      },
    ]);
    fetchMock.mockRejectedValue(new Error("connection refused"));

    await expect(shipMetricsToExecutor()).resolves.toBeUndefined();
  });

  it("swallows non-2xx responses", async () => {
    process.env.METRICS_COLLECTOR = "prometheus";
    process.env.EXECUTOR_METRICS_INGEST_URL = "http://executor:3080";
    collectCounterDeltasMock.mockResolvedValue([
      {
        name: "keeperhub_rpc_primary_attempts_total",
        labels: { chain: "ethereum", operation: "read" },
        value: 1,
      },
    ]);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    await expect(shipMetricsToExecutor()).resolves.toBeUndefined();
  });
});
