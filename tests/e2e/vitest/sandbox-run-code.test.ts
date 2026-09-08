import { describe, expect, it, vi } from "vitest";
import { runRemote } from "@/lib/sandbox/client";

// lib/sandbox/client.ts opens with `import "server-only"`, which throws under
// vitest's node env; stub it (matches the e2e-vitest convention).
vi.mock("server-only", () => ({}));

/**
 * Exercises the remote code-execution sandbox wired up by the `start-sandbox`
 * action (SANDBOX_BACKEND=remote + a live sandbox at SANDBOX_URL). This is the
 * consumer that gives the sandbox infra a real test: it drives runRemote()
 * straight against the container, so a missing/unreachable sandbox fails here
 * rather than silently passing.
 *
 * Skips cleanly when the remote backend isn't configured, so it stays inert in
 * local/unit runs that don't start a sandbox.
 */
const shouldRun =
  process.env.SANDBOX_BACKEND === "remote" && Boolean(process.env.SANDBOX_URL);

const TIMEOUT_MS = 10_000;

describe.skipIf(!shouldRun)("Sandbox run-code (remote backend)", () => {
  it("executes user code and returns the result", async () => {
    const outcome = await runRemote({
      code: "return 6 * 7;",
      timeoutMs: TIMEOUT_MS,
    });

    expect(outcome.success).toBe(true);
    if (outcome.success) {
      expect(outcome.result).toBe(42);
    }
  });

  it("captures console output from user code", async () => {
    const outcome = await runRemote({
      code: "console.log('from-sandbox'); return true;",
      timeoutMs: TIMEOUT_MS,
    });

    expect(outcome.success).toBe(true);
    const logged = outcome.logs.some((entry) =>
      entry.args.some((arg) => String(arg).includes("from-sandbox"))
    );
    expect(logged).toBe(true);
  });

  it("reports a user-code error without throwing", async () => {
    const outcome = await runRemote({
      code: "throw new Error('boom');",
      timeoutMs: TIMEOUT_MS,
    });

    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error).toContain("boom");
    }
  });
});
