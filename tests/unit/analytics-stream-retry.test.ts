import { describe, expect, it } from "vitest";
import {
  nextStreamRetry,
  SSE_RECONNECT_MAX_ATTEMPTS,
} from "@/lib/analytics/stream-retry";

describe("nextStreamRetry", () => {
  it("reconnects on the first close rather than polling", () => {
    // The server recycles the stream on its lifetime, so close one is routine.
    expect(nextStreamRetry(0)).toEqual({ action: "reconnect", delayMs: 1000 });
  });

  it("backs off exponentially across attempts", () => {
    expect(nextStreamRetry(1)).toEqual({ action: "reconnect", delayMs: 2000 });
    expect(nextStreamRetry(2)).toEqual({ action: "reconnect", delayMs: 4000 });
  });

  it("falls back to polling once the attempts are spent", () => {
    expect(nextStreamRetry(SSE_RECONNECT_MAX_ATTEMPTS)).toEqual({
      action: "poll",
    });
    expect(nextStreamRetry(SSE_RECONNECT_MAX_ATTEMPTS + 1)).toEqual({
      action: "poll",
    });
  });

  it("honours overridden bounds", () => {
    expect(nextStreamRetry(0, 500, 1)).toEqual({
      action: "reconnect",
      delayMs: 500,
    });
    expect(nextStreamRetry(1, 500, 1)).toEqual({ action: "poll" });
  });
});
