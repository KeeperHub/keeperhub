/**
 * Integration test for the SIGTERM/SIGINT graceful-shutdown handlers added in
 * `src/index.ts`. Under the in-process architecture (Phase 4+), the parent
 * process owns every listener, so the K8s pod-rotation signal must stop
 * them cleanly rather than relying on OS process teardown.
 *
 * Strategy: spawn `src/index.ts` as a child with the in-proc flag on and
 * an empty-workflows mock API (so the reconcile runs once, constructs the
 * registry, and sits idle with zero listeners). Wait for "Initialization
 * complete.", signal the child, assert exit 0 and the shutdown log line.
 *
 * An empty workflow list still exercises `shutdownRegistry()` because
 * `reconcileInproc` calls `getRegistry()` unconditionally, which lazily
 * constructs the registry (opening the Redis dedup connection). stopAll
 * then closes it. A later test could assert zero Redis connections remain
 * on the test instance, but that is over-fitting to internal state.
 *
 * Requires the `test` docker-compose profile (specifically test-redis;
 * anvil and localstack are not touched). Skipped when SKIP_INFRA_TESTS=true.
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MockApiServer, startMockApi } from "./helpers/mock-api";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const TRACKER_ENTRY = path.resolve(currentDir, "../../src/index.ts");

const SKIP_INFRA_TESTS = process.env.SKIP_INFRA_TESTS === "true";
const AWS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4567";
const REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const REDIS_PORT = process.env.REDIS_PORT ?? "6380";

const INIT_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(SKIP_INFRA_TESTS)(
  "event-tracker: graceful shutdown on process signals",
  () => {
    let mockApi: MockApiServer;

    beforeAll(async () => {
      mockApi = await startMockApi();
      // Empty workflows: registry is created (lazy) but holds no listeners.
      mockApi.setResponse("/api/workflows/events", {
        workflows: [],
        networks: {},
      });
    });

    afterAll(async () => {
      await mockApi?.close();
    });

    it(
      "SIGTERM triggers shutdownRegistry and exits 0",
      async () => {
        const { exitCode, stdout } = await runAndSignal("SIGTERM");
        expect(stdout).toContain("[Shutdown] received SIGTERM");
        expect(exitCode).toBe(0);
      },
      INIT_TIMEOUT_MS + EXIT_TIMEOUT_MS + 10_000,
    );

    it(
      "SIGINT triggers shutdownRegistry and exits 0",
      async () => {
        const { exitCode, stdout } = await runAndSignal("SIGINT");
        expect(stdout).toContain("[Shutdown] received SIGINT");
        expect(exitCode).toBe(0);
      },
      INIT_TIMEOUT_MS + EXIT_TIMEOUT_MS + 10_000,
    );

    async function runAndSignal(
      signal: "SIGTERM" | "SIGINT",
    ): Promise<SpawnResult> {
      const child = spawn("node", ["--import", "tsx/esm", TRACKER_ENTRY], {
        env: {
          ...process.env,
          KEEPERHUB_API_URL: mockApi.url,
          INTERNAL_SERVICE_HMAC_SECRET:
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          SQS_QUEUE_URL: `${AWS_ENDPOINT}/000000000000/dummy-shutdown-test`,
          AWS_ENDPOINT_URL: AWS_ENDPOINT,
          AWS_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "test",
          AWS_SECRET_ACCESS_KEY: "test",
          REDIS_HOST,
          REDIS_PORT,
          NODE_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d.toString()));
      child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d.toString()));

      try {
        await waitForLog(
          () => stdoutChunks.join("").includes("Initialization complete."),
          INIT_TIMEOUT_MS,
        );
        child.kill(signal);
        const exitCode = await waitForExit(child, EXIT_TIMEOUT_MS);
        return {
          exitCode,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
        };
      } catch (err) {
        // Never leak a child process on assertion failure.
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        throw err;
      }
    }
  },
);

async function waitForLog(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForLog timed out after ${timeoutMs}ms`);
    }
    await sleep(100);
  }
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
