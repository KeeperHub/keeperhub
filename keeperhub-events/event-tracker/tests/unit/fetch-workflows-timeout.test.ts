import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/utils/logger", () => ({ logger: { warn: vi.fn() } }));

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../../lib/config/environment");
});

describe("workflow discovery timeout", () => {
  it("releases startup when the events API accepts a connection but never responds", async () => {
    let requested = false;
    const server = createServer(() => {
      requested = true;
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing local test listener");
    }
    vi.doMock("../../lib/config/environment", () => ({
      KEEPERHUB_API_URL: `http://127.0.0.1:${address.port}`,
    }));
    const { fetchActiveWorkflows } = await import(
      "../../lib/utils/fetch-utils"
    );
    try {
      const result = await fetchActiveWorkflows(AbortSignal.timeout(250));
      expect(requested).toBe(true);
      expect(result).toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
