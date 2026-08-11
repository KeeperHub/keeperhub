/**
 * Contract test: the HMAC signing string is implemented in two languages --
 * the shell producer (deploy/scripts/reaper.sh) and the TypeScript verifier
 * (lib/internal-service-auth.ts). Every other test mocks
 * authenticateInternalService, and the TS test helper re-implements the
 * format, so nothing actually pins the SHELL producer against the verifier.
 * A drift in reaper.sh (pathname extraction, field order, body digest, the
 * caller string) would ship a silent 401 in prod that no unit test catches.
 *
 * This test runs the real reaper.sh against a stub `curl` (so no network is
 * touched), captures the X-KH-* headers it produced, and asserts the real,
 * unmocked verifier accepts them as caller "scheduler". Only the secret store
 * is mocked, so the secret reaper.sh signs with matches the one the verifier
 * looks up.
 *
 * Skipped automatically when `sh`/`openssl` are unavailable so it cannot wedge
 * a minimal runner; in normal CI (Debian-based node image) both are present.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_SECRET = "test-shared-secret-do-not-use-in-production";
const SECRET_LOOKUP_KEY = "*shared*";
const SCAN_URL =
  "http://keeperhub-common:3000/api/cron/security-behavioral-scan";

const { mockListActive, mockLookup } = vi.hoisted(() => ({
  mockListActive:
    vi.fn<
      (caller: string) => Promise<{ secret: string; keyVersion: number }[]>
    >(),
  mockLookup:
    vi.fn<
      (
        caller: string,
        keyVersion?: number
      ) => Promise<{ secret: string; keyVersion: number } | null>
    >(),
}));

vi.mock("@/lib/internal-service-hmac-store", () => ({
  listActiveHmacSecrets: mockListActive,
  lookupHmacSecret: mockLookup,
  insertHmacSecret: vi.fn(),
}));

function hasBinary(name: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const shellSigningAvailable = hasBinary("sh") && hasBinary("openssl");

const reaperPath = fileURLToPath(
  new URL("../../deploy/scripts/reaper.sh", import.meta.url)
);

const HEADER_LINE_RE = /^(X-KH-[A-Za-z-]+):\s*(.+)$/;
const TIMESTAMP_RE = /^\d+$/;
const SIGNATURE_HEX_RE = /^[0-9a-f]{64}$/;

// One stub-curl dir shared by the suite. The stub prints the -H header values
// reaper.sh passed it, then a -w-style trailer carrying a 200 so reaper.sh's
// status check passes and it exits 0.
let stubDir = "";

function runReaper(url: string): Record<string, string> {
  const result = spawnSync("sh", [reaperPath, url], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      INTERNAL_SERVICE_HMAC_SECRET: TEST_SECRET,
    },
  });

  if (result.status !== 0) {
    throw new Error(
      `reaper.sh exited ${result.status}: ${result.stderr || result.stdout}`
    );
  }

  const headers: Record<string, string> = {};
  for (const line of result.stdout.split("\n")) {
    const match = line.match(HEADER_LINE_RE);
    if (match) {
      headers[match[1]] = match[2];
    }
  }
  return headers;
}

describe.runIf(shellSigningAvailable)(
  "reaper.sh -> verifier signing contract",
  () => {
    beforeEach(() => {
      mockListActive.mockReset();
      mockLookup.mockReset();
      mockListActive.mockResolvedValue([
        { secret: TEST_SECRET, keyVersion: 1 },
      ]);

      stubDir = mkdtempSync(join(tmpdir(), "reaper-curl-stub-"));
      const stub = [
        "#!/bin/sh",
        "while [ $# -gt 0 ]; do",
        '  case "$1" in',
        "    -H) printf '%s\\n' \"$2\"; shift 2 ;;",
        "    *) shift ;;",
        "  esac",
        "done",
        'printf \'{"http_code":200,"time_total":0.01}\\n\'',
        "",
      ].join("\n");
      writeFileSync(join(stubDir, "curl"), stub, { mode: 0o755 });
    });

    afterAll(() => {
      if (stubDir) {
        rmSync(stubDir, { recursive: true, force: true });
      }
    });

    it("produces headers the unmocked verifier accepts as caller scheduler", async () => {
      const headers = runReaper(SCAN_URL);

      // Sanity: the producer emitted the three signed headers.
      expect(headers["X-KH-Caller"]).toBe("scheduler");
      expect(headers["X-KH-Timestamp"]).toMatch(TIMESTAMP_RE);
      expect(headers["X-KH-Signature"]).toMatch(SIGNATURE_HEX_RE);

      const { authenticateInternalService } = await import(
        "@/lib/internal-service-auth"
      );
      const result = await authenticateInternalService(
        new Request(SCAN_URL, { method: "GET", headers })
      );

      expect(result).toMatchObject({
        authenticated: true,
        caller: "scheduler",
        scheme: "hmac",
      });
      expect(mockListActive).toHaveBeenCalledWith(SECRET_LOOKUP_KEY);
    });

    it("is rejected when the shell-produced signature is tampered", async () => {
      const headers = runReaper(SCAN_URL);
      // Flip the first hex nibble so the signature stays 64 hex chars (passes
      // the length pre-check) but no longer verifies -- proving the positive
      // case above is not trivially passing.
      const sig = headers["X-KH-Signature"];
      headers["X-KH-Signature"] = (sig[0] === "0" ? "1" : "0") + sig.slice(1);

      const { authenticateInternalService } = await import(
        "@/lib/internal-service-auth"
      );
      const result = await authenticateInternalService(
        new Request(SCAN_URL, { method: "GET", headers })
      );

      expect(result.authenticated).toBe(false);
    });
  }
);
