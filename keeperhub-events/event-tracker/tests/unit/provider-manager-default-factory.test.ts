import { EventEmitter } from "node:events";
import { ethers } from "ethers";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Locks in the invariant that the bad-URL crash fix
 * (provider-manager.ts:165 defaultFactory) relies on:
 *
 * `ethers.WebSocketProvider(creator)` does NOT remove or replace
 * EventEmitter-style listeners attached to the underlying socket. ethers
 * assigns to `socket.onerror` (a property), which coexists with
 * `socket.on("error", ...)` listeners on the same EventEmitter. If a
 * future ethers upgrade started calling `socket.removeAllListeners`
 * inside `_start()`, our defensive listener would be stripped and the
 * crash-on-bad-URL bug would resurface.
 *
 * Distinct from `provider-manager-bad-url.test.ts` which uses real
 * network. This one is offline and runs as a fast unit check.
 */

class MockWsSocket extends EventEmitter {
  url: string;
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    super();
    this.url = url;
  }
  send(_payload: string): void {
    // not used in this test
  }
  close(_code?: number, _reason?: string): void {
    // not used in this test
  }
}

describe("defaultFactory creator pattern: ethers compatibility", () => {
  const providers: ethers.WebSocketProvider[] = [];

  afterEach(async () => {
    while (providers.length) {
      const p = providers.pop();
      if (p) {
        await p.destroy().catch(() => undefined);
      }
    }
  });

  it("EventEmitter on('error') listener attached inside the creator survives ethers' WebSocketProvider construction", () => {
    // Mirror what defaultFactory does: create a socket, attach the
    // defensive `on("error", noop)` listener synchronously, then hand
    // it to ethers via the creator overload.
    const socket = new MockWsSocket("ws://test/");
    socket.on("error", () => {
      // Mirrors the no-op in defaultFactory.
    });
    expect(socket.listenerCount("error")).toBe(1);

    const provider = new ethers.WebSocketProvider(
      () => socket as unknown as ethers.WebSocketLike,
    );
    providers.push(provider);

    // The defensive listener must still be attached after ethers wires
    // up its own onerror. ethers uses property assignment (independent
    // of EventEmitter listener storage), so listenerCount stays >= 1.
    // This is the load-bearing invariant: if it ever drops to 0, an
    // early `error` event from the underlying ws would re-throw and
    // crash the pod again.
    expect(socket.listenerCount("error")).toBeGreaterThanOrEqual(1);
  });

  it("ethers does not call removeAllListeners on the socket after construction", () => {
    // Belt-and-suspenders: even if ethers attaches its own
    // EventEmitter-style listener on top of ours, what matters is that
    // it does not remove ours. Spy removeAllListeners and assert it is
    // never called by ethers.
    const socket = new MockWsSocket("ws://test/");
    let removeAllCalled = 0;
    const orig = socket.removeAllListeners.bind(socket);
    socket.removeAllListeners = ((event?: string | symbol) => {
      removeAllCalled++;
      return orig(event);
    }) as typeof socket.removeAllListeners;

    socket.on("error", () => {
      // defensive
    });

    const provider = new ethers.WebSocketProvider(
      () => socket as unknown as ethers.WebSocketLike,
    );
    providers.push(provider);

    expect(removeAllCalled).toBe(0);
  });
});
