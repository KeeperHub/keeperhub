import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChainProviderManager } from "../../src/chains/provider-manager";

/**
 * Live-network test for the failure modes that crashed the pod during
 * KEEP-434 manual verification: a misconfigured WSS URL throwing at the
 * underlying `ws` socket level (DNS NXDOMAIN, ECONNREFUSED, non-WS server)
 * was leaking past `openProvider`'s try/catch and reaching
 * `process.on("uncaughtException")` in `index.ts`, which exits the pod.
 *
 * Uses `ws://127.0.0.1:1` (port 1 is unused on Linux, ECONNREFUSED is
 * synchronous and deterministic - no real DNS or remote network).
 *
 * Exercises the REAL `defaultFactory` path (no injected mock) because the
 * bug is in the ws library's interaction with ethers' WebSocketProvider,
 * which the unit-test MockProvider does not simulate.
 */
describe("ChainProviderManager (real ws): bad-URL safety", () => {
  let onPermanentFailure: () => void;
  let manager: ChainProviderManager;

  // Capture any uncaughtException that escapes during a test. Vitest
  // installs its own listener for failure reporting; we record errors
  // alongside it without removing it.
  const capturedExceptions: unknown[] = [];
  const listener = (err: unknown): void => {
    capturedExceptions.push(err);
  };

  beforeEach(() => {
    capturedExceptions.length = 0;
    process.on("uncaughtException", listener);
    onPermanentFailure = (): void => {
      // No-op so reconnect exhaustion does not call process.exit during
      // tests. Real prod uses defaultOnPermanentFailure which exits.
    };
    manager = new ChainProviderManager({ onPermanentFailure });
  });

  afterEach(async () => {
    process.off("uncaughtException", listener);
    await manager.destroy();
  });

  it("rejects cleanly when the only URL is unreachable (ECONNREFUSED)", async () => {
    // Pre-fix: this leaked `Error: connect ECONNREFUSED 127.0.0.1:1`
    // to process.uncaughtException via ws's EventEmitter throw, the
    // fatal handler in index.ts called process.exit(1), and K8s would
    // crashloop the pod. Post-fix: the no-op error listener in
    // defaultFactory keeps the ws emit harmless and the rejection
    // surfaces through the awaited path.
    await expect(
      manager.getOrCreateProvider(31337, "ws://127.0.0.1:1"),
    ).rejects.toThrow(/ws:\/\/127\.0\.0\.1:1/);

    expect(capturedExceptions).toEqual([]);
  });

  it("walks to the fallback when the primary is unreachable, surfacing both failures if both die", async () => {
    // Both URLs unreachable - same crash path as above for each
    // attempt. The aggregate error must mention both URLs and no
    // uncaughtException is allowed.
    await expect(
      manager.getOrCreateProvider(
        31_338,
        "ws://127.0.0.1:1",
        "ws://127.0.0.1:2",
      ),
    ).rejects.toThrow(/ws:\/\/127\.0\.0\.1:1.*ws:\/\/127\.0\.0\.1:2/s);

    expect(capturedExceptions).toEqual([]);
  });

  it("rejects cleanly when the host does not resolve (DNS NXDOMAIN)", async () => {
    // Different failure mode than ECONNREFUSED: the .invalid TLD is
    // reserved per RFC 6761 and guaranteed to never resolve, so this
    // exercises the dns.lookup error path (`getaddrinfo ENOTFOUND`).
    // That was the original failure mode I hit during KEEP-434 manual
    // verification - the error came from `node:dns` rather than
    // `ws.ClientRequest`, but the same EventEmitter-throw rule made it
    // crash the pod. The fix's defensive listener covers both because
    // ws emits 'error' on the WebSocket regardless of which network
    // layer surfaced the failure.
    await expect(
      manager.getOrCreateProvider(
        31_339,
        "wss://does-not-exist-keep434.invalid/",
      ),
    ).rejects.toThrow(/does-not-exist-keep434\.invalid/);

    expect(capturedExceptions).toEqual([]);
  });
});
