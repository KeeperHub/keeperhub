/**
 * Sandbox Escape-Matrix E2E suite (Phase 38).
 *
 * Proves that the three known exfil paths + two defence-in-depth paths
 * are closed when SANDBOX_BACKEND=remote. Runs against a deployed
 * KeeperHub environment via the public workflow-execution REST API so
 * the test exercises the full selector -> sandbox-client -> sandbox
 * service stack exactly as a production user workflow would.
 *
 * Prerequisites (see tests/e2e/sandbox-escape/README.md):
 *   STAGING_URL=https://staging.keeperhub.com (or http://localhost:3000 for minikube)
 *   STAGING_API_TOKEN=<workflow-creation + execution scope>
 *   EXPECTED_SENTINEL=<sentinel planted in main-app env for this test run>
 *
 * Skips cleanly if any of the three env vars are missing so unit/CI runs
 * that don't have staging wiring don't fail.
 */
import { describe, expect, it } from "vitest";

const STAGING_URL = process.env.STAGING_URL ?? "";
const STAGING_API_TOKEN = process.env.STAGING_API_TOKEN ?? "";
const EXPECTED_SENTINEL = process.env.EXPECTED_SENTINEL ?? "";

const SHOULD_RUN =
  STAGING_URL !== "" && STAGING_API_TOKEN !== "" && EXPECTED_SENTINEL !== "";

// Small helper wrapping the platform's synchronous code-execution API.
// Endpoint shape matches lib/api/execute/ — exact path to be confirmed
// against the deployed route table (the API surface is stable but the
// concrete URL differs between v1.7 direct-execution and v1.9 workflow
// listing paths).
type RunCodeApiResponse = {
  success: boolean;
  result?: unknown;
  error?: string;
  logs?: Array<{ level: string; args: unknown[] }>;
  line?: number;
};

async function runUserCodeAgainstRemoteSandbox(
  code: string
): Promise<RunCodeApiResponse> {
  const url = `${STAGING_URL}/api/v1/execute/run-code`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${STAGING_API_TOKEN}`,
    },
    body: JSON.stringify({ code, timeout: 10 }),
  });
  if (!res.ok) {
    throw new Error(`run-code API returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as RunCodeApiResponse;
}

// Regex literals hoisted to module scope to satisfy the
// useTopLevelRegex lint rule (avoids per-call allocation) and to make
// the assertions easy to scan as a group.
const READ_FAILED_ENOENT_RX = /READ_FAILED:\s*(ENOENT|no such file)/i;
const SHELL_SPAWN_ERROR_RX = /ENOENT|EACCES|EPERM/i;
const READONLY_FS_ERROR_RX = /EROFS|EACCES|EPERM/i;
const TCP_DROP_ERROR_RX =
  /TIMEOUT|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i;
const TCP_NET_DROP_RX = /TIMEOUT|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT/i;

describe.skipIf(!SHOULD_RUN)("Sandbox Escape Matrix (Phase 38 E2E)", () => {
  it("TEST-01: Error.constructor escape cannot read CHILD_ENV_ALLOWLIST-external vars", async () => {
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `const p = Error.constructor("return process")();
       return JSON.stringify({ keys: Object.keys(p.env), snap: p.env });`
    );
    expect(outcome.success).toBe(true);
    const serialized = JSON.stringify(outcome.result ?? {});
    expect(serialized).not.toContain(EXPECTED_SENTINEL);
  });

  it("TEST-02: /proc/self/environ inside sandbox does not contain main-pod secret", async () => {
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `try {
         const p = Error.constructor("return process")();
         const fs = p.mainModule.require("fs");
         return fs.readFileSync("/proc/self/environ", "utf8");
       } catch (e) { return "READ_FAILED: " + (e && e.message ? e.message : String(e)); }`
    );
    expect(outcome.success).toBe(true);
    expect(String(outcome.result ?? "")).not.toContain(EXPECTED_SENTINEL);
  });

  it("TEST-03: /proc/1/environ and /proc/<ppid>/environ do not reveal main-pod secrets", async () => {
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `try {
         const p = Error.constructor("return process")();
         const fs = p.mainModule.require("fs");
         const pid1 = (() => { try { return fs.readFileSync("/proc/1/environ", "utf8"); } catch (e) { return "ENOENT_OR_FAIL"; } })();
         const ppid = (() => { try { return fs.readFileSync("/proc/" + p.ppid + "/environ", "utf8"); } catch (e) { return "ENOENT_OR_FAIL"; } })();
         return { pid1, ppid };
       } catch (e) { return { pid1: "OUTER_FAIL", ppid: "OUTER_FAIL" }; }`
    );
    expect(outcome.success).toBe(true);
    const payload = JSON.stringify(outcome.result ?? {});
    expect(payload).not.toContain(EXPECTED_SENTINEL);
  });

  it("TEST-04: /var/run/secrets/kubernetes.io/serviceaccount/token is ENOENT", async () => {
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `try {
         const p = Error.constructor("return process")();
         const fs = p.mainModule.require("fs");
         return fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8");
       } catch (e) { return "READ_FAILED: " + (e && e.code ? e.code : (e && e.message ? e.message : String(e))); }`
    );
    expect(outcome.success).toBe(true);
    const result = String(outcome.result ?? "");
    expect(result).toMatch(READ_FAILED_ENOENT_RX);
    expect(result).not.toContain(EXPECTED_SENTINEL);
  });

  it("TEST-05: /var/run/secrets/eks.amazonaws.com/serviceaccount/token is ENOENT", async () => {
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `try {
         const p = Error.constructor("return process")();
         const fs = p.mainModule.require("fs");
         return fs.readFileSync("/var/run/secrets/eks.amazonaws.com/serviceaccount/token", "utf8");
       } catch (e) { return "READ_FAILED: " + (e && e.code ? e.code : (e && e.message ? e.message : String(e))); }`
    );
    expect(outcome.success).toBe(true);
    const result = String(outcome.result ?? "");
    expect(result).toMatch(READ_FAILED_ENOENT_RX);
    expect(result).not.toContain(EXPECTED_SENTINEL);
  });

  // TEST-06..10: post-Tier-1 hardening assertions. These assume the
  // sandbox is running on the distroless runtime image
  // (gcr.io/distroless/nodejs24-debian12), with readOnlyRootFilesystem,
  // tmpfs /tmp, and the egress-deny NetworkPolicy. They fail loudly if
  // any of those regress.

  it("TEST-06: distroless image has no /bin/sh, no busybox, no spawnable shell", async () => {
    // child_process.spawn returns a ChildProcess that emits "error" with
    // code ENOENT when the binary does not exist. We try every common
    // shell path; all must fail to spawn.
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `const p = Error.constructor("return process")();
       const cp = p.mainModule.require("child_process");
       const candidates = ["/bin/sh", "/bin/bash", "/bin/ash", "/bin/busybox", "/usr/bin/sh"];
       const results = await Promise.all(candidates.map(bin => new Promise(resolve => {
         try {
           const child = cp.spawn(bin, ["-c", "echo SHELL_PRESENT"], { stdio: ["ignore", "pipe", "pipe"] });
           let spawned = false;
           child.on("spawn", () => { spawned = true; });
           child.on("error", e => resolve({ bin, ok: false, code: e && e.code ? e.code : "ERR" }));
           child.on("close", code => resolve({ bin, ok: spawned, code }));
         } catch (e) {
           resolve({ bin, ok: false, code: e && e.code ? e.code : "THROW" });
         }
       })));
       return results;`
    );
    expect(outcome.success).toBe(true);
    const results = outcome.result as Array<{
      bin: string;
      ok: boolean;
      code: string | number;
    }>;
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(String(r.code)).toMatch(SHELL_SPAWN_ERROR_RX);
    }
  });

  it("TEST-07: readOnlyRootFilesystem blocks writes outside /tmp", async () => {
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `const p = Error.constructor("return process")();
       const fs = p.mainModule.require("fs");
       const attempts = ["/etc/keeperhub-tampering-canary", "/usr/keeperhub-tampering-canary", "/keeperhub-tampering-canary"];
       const results = attempts.map(path => {
         try { fs.writeFileSync(path, "x"); return { path, ok: true, code: null }; }
         catch (e) { return { path, ok: false, code: e && e.code ? e.code : String(e) }; }
       });
       // sanity: a write to the tmpfs /tmp must succeed (so we're not just blocked everywhere)
       let tmpOk = false;
       try { fs.writeFileSync("/tmp/keeperhub-tmpfs-canary", "x"); fs.unlinkSync("/tmp/keeperhub-tmpfs-canary"); tmpOk = true; } catch (_) {}
       return { results, tmpOk };`
    );
    expect(outcome.success).toBe(true);
    const payload = outcome.result as {
      results: Array<{ path: string; ok: boolean; code: string | null }>;
      tmpOk: boolean;
    };
    for (const r of payload.results) {
      expect(r.ok).toBe(false);
      expect(String(r.code)).toMatch(READONLY_FS_ERROR_RX);
    }
    expect(payload.tmpOk).toBe(true);
  });

  it("TEST-08: NetworkPolicy denies TCP to in-cluster Services (postgres, redis, main app)", async () => {
    // Try to open raw TCP to canonical in-cluster ClusterIP targets via
    // require("net"). Successful connect => NetworkPolicy regression.
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `const p = Error.constructor("return process")();
       const net = p.mainModule.require("net");
       const targets = [
         { host: "postgres.keeperhub.svc.cluster.local", port: 5432 },
         { host: "redis.keeperhub.svc.cluster.local", port: 6379 },
         { host: "keeperhub-staging-common.keeperhub.svc.cluster.local", port: 3000 },
         { host: "keeperhub-prod-common.keeperhub.svc.cluster.local", port: 3000 },
       ];
       const probe = (t) => new Promise(resolve => {
         const sock = net.createConnection({ host: t.host, port: t.port, timeout: 2500 });
         let resolved = false;
         const settle = (r) => { if (!resolved) { resolved = true; try { sock.destroy(); } catch (_) {} resolve(r); } };
         sock.on("connect", () => settle({ ...t, connected: true, code: null }));
         sock.on("error", e => settle({ ...t, connected: false, code: e && e.code ? e.code : "ERR" }));
         sock.on("timeout", () => settle({ ...t, connected: false, code: "TIMEOUT" }));
       });
       return await Promise.all(targets.map(probe));`
    );
    expect(outcome.success).toBe(true);
    const results = outcome.result as Array<{
      host: string;
      port: number;
      connected: boolean;
      code: string | null;
    }>;
    for (const r of results) {
      expect(r.connected).toBe(false);
      // VPC CNI NP enforces drop at the agent; common error codes are
      // ETIMEDOUT (silent drop), EHOSTUNREACH, or ECONNREFUSED depending
      // on which side rejects first. EAI_AGAIN/ENOTFOUND would mean DNS
      // failed before TCP even tried (also acceptable since we deny
      // resolution of in-cluster names that the policy blocks).
      expect(String(r.code)).toMatch(TCP_DROP_ERROR_RX);
    }
  });

  it("TEST-09: NetworkPolicy denies raw TCP to AWS IMDS (169.254.169.254)", async () => {
    // SSRF guard catches fetch() to 169.254/16 (TEST in sandbox/src/run-code.test.ts).
    // This case probes the network layer specifically: require("net") direct
    // connect should be dropped by the NetworkPolicy egress except list.
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `const p = Error.constructor("return process")();
       const net = p.mainModule.require("net");
       return await new Promise(resolve => {
         const sock = net.createConnection({ host: "169.254.169.254", port: 80, timeout: 2500 });
         let resolved = false;
         const settle = (r) => { if (!resolved) { resolved = true; try { sock.destroy(); } catch (_) {} resolve(r); } };
         sock.on("connect", () => settle({ connected: true, code: null }));
         sock.on("error", e => settle({ connected: false, code: e && e.code ? e.code : "ERR" }));
         sock.on("timeout", () => settle({ connected: false, code: "TIMEOUT" }));
       });`
    );
    expect(outcome.success).toBe(true);
    const r = outcome.result as { connected: boolean; code: string | null };
    expect(r.connected).toBe(false);
    expect(String(r.code)).toMatch(TCP_NET_DROP_RX);
  });

  it("TEST-10: NetworkPolicy denies HTTPS to private RFC1918 destinations", async () => {
    // public 443 is allowed; private 443 is in the NP except list. A
    // TCP connect to a private CIDR on port 443 must fail.
    const outcome = await runUserCodeAgainstRemoteSandbox(
      `const p = Error.constructor("return process")();
       const net = p.mainModule.require("net");
       const targets = [
         { host: "10.0.0.1", port: 443 },
         { host: "172.16.0.1", port: 443 },
         { host: "192.168.0.1", port: 443 },
       ];
       const probe = (t) => new Promise(resolve => {
         const sock = net.createConnection({ host: t.host, port: t.port, timeout: 2500 });
         let resolved = false;
         const settle = (r) => { if (!resolved) { resolved = true; try { sock.destroy(); } catch (_) {} resolve(r); } };
         sock.on("connect", () => settle({ ...t, connected: true, code: null }));
         sock.on("error", e => settle({ ...t, connected: false, code: e && e.code ? e.code : "ERR" }));
         sock.on("timeout", () => settle({ ...t, connected: false, code: "TIMEOUT" }));
       });
       return await Promise.all(targets.map(probe));`
    );
    expect(outcome.success).toBe(true);
    const results = outcome.result as Array<{
      host: string;
      connected: boolean;
      code: string | null;
    }>;
    for (const r of results) {
      expect(r.connected).toBe(false);
      expect(String(r.code)).toMatch(TCP_NET_DROP_RX);
    }
  });
});

// Fallback describe block surfaces a clear message in local / CI runs that
// don't have staging wiring, instead of the suite being silently empty.
describe.skipIf(SHOULD_RUN)(
  "Sandbox Escape Matrix (Phase 38 E2E) — skipped (set STAGING_URL, STAGING_API_TOKEN, EXPECTED_SENTINEL)",
  () => {
    it("is skipped because required env vars are not set", () => {
      expect(SHOULD_RUN).toBe(false);
    });
  }
);
