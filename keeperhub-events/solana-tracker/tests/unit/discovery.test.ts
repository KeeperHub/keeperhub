import { afterEach, describe, expect, it, vi } from "vitest";

// Set before the module graph loads (environment.ts reads it at import time):
// signHmacHeaders parses the request URL with `new URL(...)`, which needs an
// absolute base.
vi.hoisted(() => {
  process.env.KEEPERHUB_API_URL = "http://localhost:3000";
});

import { fetchSolanaTriggers } from "../../src/discovery";

type EndpointResult = { ok: boolean; body?: unknown };

function stubFetch(handlers: {
  events: EndpointResult;
  blocks: EndpointResult;
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const result = url.includes("/api/workflows/events")
        ? handlers.events
        : handlers.blocks;
      return Promise.resolve({
        ok: result.ok,
        status: result.ok ? 200 : 500,
        json: () => Promise.resolve(result.body ?? {}),
      } as Response);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSolanaTriggers partial-failure handling", () => {
  it("returns null when the block endpoint fails (no partial reconcile)", async () => {
    stubFetch({
      events: { ok: true, body: { workflows: [], networks: {} } },
      blocks: { ok: false },
    });
    expect(await fetchSolanaTriggers()).toBeNull();
  });

  it("returns null when the event endpoint fails", async () => {
    stubFetch({
      events: { ok: false },
      blocks: { ok: true, body: { workflows: [], networks: {} } },
    });
    expect(await fetchSolanaTriggers()).toBeNull();
  });

  it("returns null when both endpoints fail", async () => {
    stubFetch({ events: { ok: false }, blocks: { ok: false } });
    expect(await fetchSolanaTriggers()).toBeNull();
  });

  it("merges both sides only when both endpoints succeed", async () => {
    stubFetch({
      events: { ok: true, body: { workflows: [{ id: "e" }], networks: {} } },
      blocks: { ok: true, body: { workflows: [{ id: "b" }], networks: {} } },
    });
    const data = await fetchSolanaTriggers();
    expect(data?.eventWorkflows).toEqual([{ id: "e" }]);
    expect(data?.blockWorkflows).toEqual([{ id: "b" }]);
  });
});
