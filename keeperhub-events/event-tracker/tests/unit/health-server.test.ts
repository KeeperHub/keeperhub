import type { AddressInfo } from "node:net";
import type { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChainProviderManager,
  type ProviderFactory,
} from "../../src/chains/provider-manager";
import {
  type HealthServerHandle,
  buildHealthResponse,
  startHealthServer,
} from "../../src/health/health-server";

class MockProvider {
  destroyed = false;
  on(): void {
    /* noop */
  }
  off(): void {
    /* noop */
  }
  async getBlockNumber(): Promise<number> {
    return 0;
  }
  async send(): Promise<unknown> {
    return 0;
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

const factory: ProviderFactory = () =>
  new MockProvider() as unknown as ethers.WebSocketProvider;

describe("health-server", () => {
  let manager: ChainProviderManager;

  beforeEach(() => {
    manager = new ChainProviderManager({
      factory,
      onPermanentFailure: () => {
        /* test does not exit the process */
      },
    });
  });

  afterEach(async () => {
    await manager.destroy();
  });

  describe("buildHealthResponse", () => {
    it("returns 200 + ok when no chains are registered", () => {
      const { status, body } = buildHealthResponse(manager);
      expect(status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.chains).toEqual([]);
    });

    it("returns 200 + ok when every registered chain is connected", async () => {
      await manager.getOrCreateProvider(1, "ws://a");
      await manager.getOrCreateProvider(2, "ws://b");
      const { status, body } = buildHealthResponse(manager);
      expect(status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.chains).toHaveLength(2);
      expect(body.chains.every((c) => c.connected)).toBe(true);
    });

    it("returns 503 + degraded when any chain is not connected", async () => {
      await manager.getOrCreateProvider(1, "ws://a");
      // Force chain 1 into a reconnecting state without waiting for the
      // real reconnect cycle: mutate the private entry via the test-only
      // escape hatch. This avoids depending on fake timers here.
      const entries = (
        manager as unknown as {
          chains: Map<number, { isReconnecting: boolean }>;
        }
      ).chains;
      const entry = entries.get(1);
      if (entry) {
        entry.isReconnecting = true;
      }

      const { status, body } = buildHealthResponse(manager);
      expect(status).toBe(503);
      expect(body.status).toBe("degraded");
      expect(body.chains[0].connected).toBe(false);
      expect(body.chains[0].reconnecting).toBe(true);
    });
  });

  describe("HTTP server", () => {
    let handle: HealthServerHandle;

    beforeEach(async () => {
      // Port 0 = let the OS assign a free one, avoiding port contention in CI.
      handle = await startHealthServer(manager, 0);
    });

    afterEach(async () => {
      await handle.close();
    });

    it("responds 200 on /healthz when no chains registered", async () => {
      const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; chains: unknown[] };
      expect(body.status).toBe("ok");
      expect(body.chains).toEqual([]);
    });

    it("responds 503 on /healthz when a chain is reconnecting", async () => {
      await manager.getOrCreateProvider(1, "ws://a");
      const entries = (
        manager as unknown as {
          chains: Map<number, { isReconnecting: boolean }>;
        }
      ).chains;
      const entry = entries.get(1);
      if (entry) {
        entry.isReconnecting = true;
      }

      const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("degraded");
    });

    it("responds 404 on unknown paths", async () => {
      const res = await fetch(`http://127.0.0.1:${handle.port}/nope`);
      expect(res.status).toBe(404);
    });

    it("strips query strings from /healthz", async () => {
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/healthz?verbose=1`,
      );
      expect(res.status).toBe(200);
    });

    it("binds to a concrete port via the returned handle", () => {
      expect(handle.port).toBeGreaterThan(0);
      const address = handle.server.address() as AddressInfo;
      expect(address.port).toBe(handle.port);
    });
  });
});
