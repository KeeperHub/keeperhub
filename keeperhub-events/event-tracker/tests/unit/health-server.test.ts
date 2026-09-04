import type { AddressInfo } from "node:net";
import type { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChainProviderManager,
  type ProviderFactory,
  redactRpcUrl,
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

describe("RPC URL redaction", () => {
  it("keeps scheme and host, drops the credential-bearing path", () => {
    // The shape that matters: chain-config stores ${DRPC_API_KEY} as a
    // placeholder, and the deploy workflow substitutes the real key into the
    // value before writing it to SSM, so this string is a live secret at
    // runtime for 19 of 22 chains.
    expect(
      redactRpcUrl("wss://lb.drpc.live/robinhood-mainnet/sk_live_abc123"),
    ).toBe("wss://lb.drpc.live/[redacted]");
    expect(redactRpcUrl("https://eth-mainnet.g.alchemy.com/v2/SECRETKEY")).toBe(
      "https://eth-mainnet.g.alchemy.com/[redacted]",
    );
  });

  it("redacts a key passed as a query parameter", () => {
    expect(redactRpcUrl("wss://rpc.example.com/?apiKey=SECRET")).toBe(
      "wss://rpc.example.com/[redacted]",
    );
  });

  it("strips credentials given as URL userinfo", () => {
    const out = redactRpcUrl("wss://user:hunter2@rpc.example.com/path");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("user");
  });

  it("keeps a bare host readable so failover is still diagnosable", () => {
    // Redaction has to leave the upstream identifiable, or the field stops
    // answering the question it exists for.
    expect(redactRpcUrl("wss://chain.techops.services")).toBe(
      "wss://chain.techops.services",
    );
  });

  it("passes null through and fails closed on anything unparseable", () => {
    expect(redactRpcUrl(null)).toBeNull();
    expect(redactRpcUrl("not a url")).toBe("[redacted]");
    expect(redactRpcUrl("")).toBe("[redacted]");
  });

  it("never returns a string containing the original secret", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    for (const url of [
      `wss://lb.drpc.live/base/${secret}`,
      `https://host/v2/${secret}?k=${secret}`,
      `wss://x:${secret}@host/p`,
    ]) {
      expect(redactRpcUrl(url)).not.toContain(secret);
    }
  });
});

describe("no credential reaches the health payload", () => {
  // The helper being correct is not the property that matters. The property
  // is that nothing secret leaves buildHealthResponse - reverting only the
  // toHealth() call site left the helper intact and the whole suite green
  // while /healthz served raw credentials.
  const SECRET = "dk_live_0123456789abcdef0123456789abcdef";

  it("omits the credential from every field, including error strings", async () => {
    // A factory that always throws: both URLs fail, so the aggregate error -
    // which names every URL it tried - lands on lastCreateError.
    const failingFactory: ProviderFactory = () => {
      throw new Error("ECONNREFUSED");
    };
    const mgr = new ChainProviderManager({
      factory: failingFactory,
      onPermanentFailure: () => undefined,
    });
    const primary = "wss://chain.techops.services/eth-mainnet";
    const fallback = `wss://lb.drpc.live/eth-mainnet/${SECRET}`;

    await mgr
      .subscribeToLogs({
        chainId: 1,
        wssUrl: primary,
        fallbackWssUrl: fallback,
        address: "0x1111111111111111111111111111111111111111",
        topic0:
          "0x6d7747ff9aaba238de658957a12a32c8a94f6ec3aa0508441fe400ca79ed457c",
        handler: () => undefined,
      })
      .catch(() => undefined);

    const body = JSON.stringify(buildHealthResponse(mgr).body);
    expect(body).not.toContain(SECRET);
    await mgr.destroy();
  });
});
