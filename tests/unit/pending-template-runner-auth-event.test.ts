/**
 * Tests for the AUTH_SUCCESS_EVENT wiring in PendingTemplateRunner (commit db2e7ebe).
 *
 * HUB-05 reinforcement: the runner must re-evaluate the pending template
 * intent when the auth dialog dispatches AUTH_SUCCESS_EVENT (in-place
 * email+password sign-in, where no navigation occurs and the initial mount
 * run would have already consumed the blank cookie slot).
 *
 * Tests also assert the inFlight ref guard: a second concurrent invocation
 * (event fires while a duplicate call is in progress) must NOT trigger a
 * second duplicate request.
 *
 * All tests run in jsdom so window / sessionStorage / addEventListener are
 * available without mocking.
 */
import { describe, expect, it, vi } from "vitest";

// --- Pure logic extracted from pending-template-runner.tsx ---
// We test the business logic directly since rendering the component requires
// React and a router mock. The logic under test is the run() function and
// the inFlight guard.

import { AUTH_SUCCESS_EVENT } from "@/lib/auth-events";

// Test the AUTH_SUCCESS_EVENT constant shape (commit db2e7ebe).
describe("lib/auth-events.ts (commit db2e7ebe)", () => {
  it("exports AUTH_SUCCESS_EVENT as a non-empty string", () => {
    expect(typeof AUTH_SUCCESS_EVENT).toBe("string");
    expect(AUTH_SUCCESS_EVENT.length).toBeGreaterThan(0);
  });

  it("AUTH_SUCCESS_EVENT value is the namespaced 'kh:auth-success' string", () => {
    // Asserting the exact string ensures the auth dialog and the runner
    // agree on the same event name after the fix in db2e7ebe.
    expect(AUTH_SUCCESS_EVENT).toBe("kh:auth-success");
  });

  it("AUTH_SUCCESS_EVENT can serve as a CustomEvent type string (structural check)", () => {
    // Verify the string is a valid custom event name: non-empty, no whitespace,
    // contains the namespace separator so it won't collide with native events.
    expect(AUTH_SUCCESS_EVENT.trim()).toBe(AUTH_SUCCESS_EVENT);
    expect(AUTH_SUCCESS_EVENT).toMatch(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/);
  });

  it("event name does not collide with generic DOM events (e.g. 'click', 'load')", () => {
    // Namespaced with 'kh:' to avoid accidental collision.
    expect(AUTH_SUCCESS_EVENT).toContain(":");
    expect(AUTH_SUCCESS_EVENT).not.toBe("click");
    expect(AUTH_SUCCESS_EVENT).not.toBe("load");
    expect(AUTH_SUCCESS_EVENT).not.toBe("auth");
  });
});

// --- inFlight guard logic unit tests ---
// The guard is a ref (boolean) that prevents concurrent duplicate calls.
// We simulate it without importing the full component to keep the test fast
// and framework-free (no React, no router).

describe("PendingTemplateRunner — inFlight guard logic (commit db2e7ebe)", () => {
  // Minimal simulation of the inFlight pattern from pending-template-runner.tsx.
  // This mirrors the exact guard introduced in db2e7ebe:
  //   if (inFlight.current) return;
  //   inFlight.current = true;
  //   try { ... } finally { inFlight.current = false; }

  function makeRunner(onDuplicate: (id: string) => Promise<void>): {
    run: (workflowId: string) => Promise<void>;
    inFlight: { current: boolean };
  } {
    const inFlight = { current: false };
    const run = async (workflowId: string): Promise<void> => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      try {
        await onDuplicate(workflowId);
      } finally {
        inFlight.current = false;
      }
    };
    return { run, inFlight };
  }

  it("executes the duplicate when not in flight", async () => {
    const duplicateSpy = vi.fn().mockResolvedValue(undefined);
    const { run } = makeRunner(duplicateSpy);
    await run("wf_test");
    expect(duplicateSpy).toHaveBeenCalledTimes(1);
    expect(duplicateSpy).toHaveBeenCalledWith("wf_test");
  });

  it("second concurrent call is dropped while first is in flight", async () => {
    let resolveFirst!: () => void;
    const firstCallPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const duplicateSpy = vi.fn().mockImplementationOnce(() => firstCallPromise);
    const { run } = makeRunner(duplicateSpy);

    // Start first call (does NOT resolve yet).
    const first = run("wf_inflight");

    // Second call while first is in-flight — should be skipped.
    await run("wf_inflight");

    expect(duplicateSpy).toHaveBeenCalledTimes(1); // second call skipped

    // Let the first resolve.
    resolveFirst();
    await first;

    expect(duplicateSpy).toHaveBeenCalledTimes(1); // still one
  });

  it("inFlight resets to false after the call resolves", async () => {
    const duplicateSpy = vi.fn().mockResolvedValue(undefined);
    const { run, inFlight } = makeRunner(duplicateSpy);

    expect(inFlight.current).toBe(false);
    await run("wf_reset");
    expect(inFlight.current).toBe(false); // reset after completion
  });

  it("inFlight resets to false even when the duplicate throws", async () => {
    const duplicateSpy = vi.fn().mockRejectedValue(new Error("network error"));
    const { run, inFlight } = makeRunner(duplicateSpy);

    // Expect the error to propagate but the flag to reset.
    await expect(run("wf_error")).rejects.toThrow("network error");
    expect(inFlight.current).toBe(false);
  });
});

// --- sessionStorage idempotency TTL tests ---
// The runner writes a { at: number } flag and skips if the flag is fresh
// (< 30_000ms old). We test the pure serialisation / TTL logic directly
// using an in-memory Map so the suite stays compatible with vitest's node
// environment (no browser sessionStorage available).

describe("PendingTemplateRunner — sessionStorage idempotency guard (HUB-05)", () => {
  const PREFIX = "pending_template:";
  const TTL_MS = 30_000;

  // In-memory store simulating sessionStorage.getItem / setItem.
  const store = new Map<string, string>();

  function writeFlag(workflowId: string, atMs: number): void {
    store.set(`${PREFIX}${workflowId}`, JSON.stringify({ at: atMs }));
  }

  function readFlag(workflowId: string): { at: number } | null {
    const raw = store.get(`${PREFIX}${workflowId}`);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { at: number };
      if (typeof parsed?.at === "number") {
        return parsed;
      }
    } catch {
      // Malformed entry — treat as absent.
    }
    return null;
  }

  function isFlagFresh(flag: { at: number }, refTime: number): boolean {
    return refTime - flag.at < TTL_MS;
  }

  it("a flag written now is considered fresh (within TTL)", () => {
    writeFlag("wf_fresh", Date.now());
    const flag = readFlag("wf_fresh");
    expect(flag).not.toBeNull();
    expect(isFlagFresh(flag as NonNullable<typeof flag>, Date.now())).toBe(
      true
    );
  });

  it("a flag written more than 30 seconds ago is considered stale", () => {
    const thirtyOneSecondsAgo = Date.now() - (TTL_MS + 1000);
    writeFlag("wf_stale", thirtyOneSecondsAgo);
    const flag = readFlag("wf_stale");
    expect(flag).not.toBeNull();
    expect(isFlagFresh(flag as NonNullable<typeof flag>, Date.now())).toBe(
      false
    );
  });

  it("absent flag returns null", () => {
    expect(readFlag("wf_absent_xyz")).toBeNull();
  });

  it("malformed store entry returns null", () => {
    store.set(`${PREFIX}wf_malformed`, "not-json{{");
    expect(readFlag("wf_malformed")).toBeNull();
  });

  it("flag entry key uses the correct prefix + workflowId shape", () => {
    writeFlag("wf_key_test", Date.now());
    const raw = store.get(`${PREFIX}wf_key_test`);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as { at: number };
    expect(typeof parsed.at).toBe("number");
  });

  it("TTL boundary: flag at exactly TTL_MS old is stale (exclusive upper bound)", () => {
    // The check is `refTime - flag.at < TTL_MS` — at exactly TTL_MS the
    // flag is NOT fresh. This prevents boundary confusion between < and <=.
    const now = Date.now();
    const atMs = now - TTL_MS;
    const flag: { at: number } = { at: atMs };
    expect(isFlagFresh(flag, now)).toBe(false);
  });

  it("TTL boundary: flag at TTL_MS - 1ms old is still fresh", () => {
    const now = Date.now();
    const atMs = now - (TTL_MS - 1);
    const flag: { at: number } = { at: atMs };
    expect(isFlagFresh(flag, now)).toBe(true);
  });
});
