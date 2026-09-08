import { serialize } from "node:v8";
import { describe, expect, it } from "vitest";
import {
  decodeSandboxResult,
  SANDBOX_RESULT_FD,
} from "../../lib/sandbox/child-source.js";
import {
  type ChildOutcome,
  isRelayableEnvelope,
  runCode as runCodeRaw,
  type SandboxRunResult,
} from "./run-code.js";

// runCode now returns a relayable tagged-JSON frame or a synthetic error
// outcome. The tests assert on the native ChildOutcome, so decode a relayed
// frame exactly as the main-app client does. This wrapper shadows `runCode` so
// the existing call sites need no change.
function toOutcome(result: SandboxRunResult): ChildOutcome {
  return result.relay
    ? (decodeSandboxResult(result.frame.toString("utf8")) as ChildOutcome)
    : result.outcome;
}

async function runCode(input: {
  code: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ChildOutcome> {
  return toOutcome(await runCodeRaw(input));
}

// A forged result frame an escaped child could write to fd 3: a 4-byte
// big-endian length prefix followed by a v8-serialized success outcome with an
// attacker-chosen result. Emitted as a JS literal embedded in the user code.
function forgedFrameLiteral(result: string): string {
  const payload = serialize({ ok: true, result, logs: [] });
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  const bytes = [...header, ...payload].join(",");
  return `Buffer.from([${bytes}])`;
}

describe("runCode — sandbox child_process runner", () => {
  it("returns a basic arithmetic result with empty logs", async () => {
    const outcome = await runCode({ code: "return 1 + 1;", timeoutMs: 5000 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe(2);
      expect(outcome.logs).toEqual([]);
    }
  });

  it("round-trips BigInt via v8 serialization", async () => {
    const outcome = await runCode({
      code: "return BigInt(2) ** BigInt(100);",
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe(2n ** 100n);
      expect(typeof outcome.result).toBe("bigint");
    }
  });

  it("reports a timeout for an infinite loop", async () => {
    const outcome = await runCode({
      code: "while (true) {}",
      timeoutMs: 500,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(
        outcome.errorMessage.toLowerCase().includes("timeout") ||
          outcome.errorMessage.toLowerCase().includes("timed out") ||
          outcome.errorMessage.toLowerCase().includes("script execution") ||
          outcome.errorMessage === "WALL_CLOCK_TIMEOUT"
      ).toBe(true);
    }
  });

  it("scrubs the child environment to the CHILD_ENV_ALLOWLIST only", async () => {
    // Canonical escape payload: Error.constructor("return process")() reaches
    // the host `process` object inside the vm context. Because the child was
    // spawned with execve and a scrubbed env, process.env contains ONLY the
    // allowlist keys.
    const SECRET_KEY = "SANDBOX_TEST_FAKE_SECRET_XYZ";
    const SECRET_VALUE = "leaked-value-must-not-appear";
    process.env[SECRET_KEY] = SECRET_VALUE;

    try {
      const outcome = await runCode({
        code: `const p = Error.constructor("return process")(); return Object.keys(p.env);`,
        timeoutMs: 5000,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        const envKeys = outcome.result as string[];
        // The allowlist is: NODE_ENV, NODE_EXTRA_CA_CERTS, PATH, TZ, LANG, LC_ALL.
        // The fake secret we injected must NOT be present — this is the
        // load-bearing security property. Individual OSes may inject their
        // own system-level vars (e.g. macOS __CF_USER_TEXT_ENCODING); those
        // are harmless and not under CHILD_ENV_ALLOWLIST control.
        expect(envKeys).not.toContain(SECRET_KEY);
        // Every key that IS under our control (from CHILD_ENV_ALLOWLIST)
        // may legitimately appear. Assert no non-allowlisted KeeperHub-style
        // variable leaked (anything matching uppercase APP/SECRET/KEY names).
        const leaked = envKeys.filter((k) =>
          /^(DATABASE|WALLET|STRIPE|GITHUB|GOOGLE|AGENTIC|INTEGRATION|BETTER_AUTH|OAUTH|TURNKEY|CDP|AWS|KUBERNETES)_/i.test(
            k
          )
        );
        expect(leaked).toEqual([]);
      }
    } finally {
      delete process.env[SECRET_KEY];
    }
  });

  it("blocks fetch() to the AWS IMDS metadata IP (link-local)", async () => {
    const outcome = await runCode({
      code: `return await fetch("http://169.254.169.254/latest/meta-data/");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("SSRF blocked");
    }
  });

  it("blocks fetch() to a private IPv4 literal (RFC 1918)", async () => {
    const outcome = await runCode({
      code: `return await fetch("http://10.0.0.1/");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("SSRF blocked");
    }
  });

  it("blocks fetch() to loopback IPv4", async () => {
    const outcome = await runCode({
      code: `return await fetch("http://127.0.0.1/");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("SSRF blocked");
    }
  });

  it("blocks fetch() to an IPv4-mapped IPv6 literal pointing at private IPv4", async () => {
    const outcome = await runCode({
      code: `return await fetch("http://[::ffff:169.254.169.254]/");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("SSRF blocked");
    }
  });

  it("blocks fetch() to a hostname that resolves to loopback (localhost)", async () => {
    // Deterministic on Linux/macOS: resolver always hands back 127.0.0.1 or
    // ::1 for "localhost". Exercises the DNS-resolved path, not the IP-
    // literal path.
    const outcome = await runCode({
      code: `return await fetch("http://localhost/");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("SSRF blocked");
    }
  });

  it("rejects fetch() with a non-http(s) scheme", async () => {
    const outcome = await runCode({
      code: `return await fetch("file:///etc/passwd");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toContain("scheme not allowed");
    }
  });

  it("disallows require() inside the sandbox", async () => {
    const outcome = await runCode({
      code: `return require("fs");`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toMatch(/require is not defined/i);
    }
  });

  it("round-trips Map via v8 serialization", async () => {
    const outcome = await runCode({
      code: `return new Map([["a", 1], ["b", 2]]);`,
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBeInstanceOf(Map);
      const asMap = outcome.result as Map<string, number>;
      expect(asMap.get("a")).toBe(1);
      expect(asMap.get("b")).toBe(2);
    }
  });

  it("round-trips a typed array through the tagged-JSON codec", async () => {
    const outcome = await runCode({
      code: "return new Uint8Array([1, 2, 255]);",
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBeInstanceOf(Uint8Array);
      expect([...(outcome.result as Uint8Array)]).toEqual([1, 2, 255]);
    }
  });

  it("returns a clean error for a non-serializable result", async () => {
    const outcome = await runCode({
      code: "return () => 1;",
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorMessage).toMatch(/not serializable/i);
    }
  });

  it("ignores a forged sentinel an escape writes to stdout (F-010, stdout never deserialized)", async () => {
    const code = [
      "try {",
      '  const proc = Error.constructor("return process")();',
      '  proc.stdout.write("\\u0001RESULT\\u0002////\\n");',
      "} catch (e) {}",
      'return "REAL";',
    ].join("\n");
    const outcome = await runCode({ code, timeoutMs: 1500 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe("REAL");
    }
  });

  it("keeps the real result when an escape schedules a later forged fd-3 frame (F-010)", async () => {
    // The genuine result frame is written first, so the parent's
    // first-frame-wins read discards the forged frame the escape appends later.
    const code = [
      "try {",
      '  const req = Error.constructor("return require")();',
      '  const efs = req("node:fs");',
      '  const g = Error.constructor("return globalThis")();',
      `  const forged = ${forgedFrameLiteral("FORGED")};`,
      `  g.setTimeout(function(){ try { efs.writeSync(${SANDBOX_RESULT_FD}, forged); } catch (e) {} }, 5);`,
      "} catch (e) {}",
      'return "REAL";',
    ].join("\n");
    const outcome = await runCode({ code, timeoutMs: 1500 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe("REAL");
    }
  });

  it("keeps the real result when an escape reassigns fs.writeSync then forges (F-010)", async () => {
    // writeResult uses a startup-captured __writeSync, so reassigning
    // fs.writeSync cannot suppress the genuine frame; the later forged frame
    // loses to first-frame-wins.
    const code = [
      "try {",
      '  const req = Error.constructor("return require")();',
      '  const efs = req("node:fs");',
      "  const realWrite = efs.writeSync;",
      "  efs.writeSync = function(){ return 0; };",
      '  const proc = Error.constructor("return process")();',
      "  proc.exit = function(){};",
      '  const g = Error.constructor("return globalThis")();',
      `  const forged = ${forgedFrameLiteral("FORGED")};`,
      `  g.setTimeout(function(){ try { realWrite(${SANDBOX_RESULT_FD}, forged); } catch (e) {} }, 5);`,
      "} catch (e) {}",
      'return "REAL";',
    ].join("\n");
    const outcome = await runCode({ code, timeoutMs: 1500 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toBe("REAL");
    }
  });
});

// The frame the server relays is produced by the (untrusted) grandchild; a
// vm-escaped child can forge it. The shallow relay guard confirms a plausible
// envelope on the UN-REVIVED frame; the main-app client strictly validates the
// revived form (e.g. errorStack type), so the relay guard does not inspect it.
describe("isRelayableEnvelope shallow guard", () => {
  it("accepts a valid ok:true envelope", () => {
    expect(isRelayableEnvelope({ ok: true, result: 1, logs: [] })).toBe(true);
  });

  it("accepts a valid ok:false envelope, ignoring a tagged errorStack", () => {
    expect(
      isRelayableEnvelope({ ok: false, errorMessage: "x", logs: [] })
    ).toBe(true);
    // On the un-revived frame errorStack:undefined arrives as { $: "undef" };
    // the relay guard must accept it (the client validates the revived form).
    expect(
      isRelayableEnvelope({
        ok: false,
        errorMessage: "x",
        errorStack: { $: "undef" },
        logs: [{ level: "error", args: ["y"] }],
      })
    ).toBe(true);
  });

  it("rejects ok:false without a string errorMessage", () => {
    expect(isRelayableEnvelope({ ok: false, logs: [] })).toBe(false);
  });

  it("rejects a malformed log entry", () => {
    expect(isRelayableEnvelope({ ok: true, result: 1, logs: [null] })).toBe(
      false
    );
  });

  it("rejects missing or non-array logs", () => {
    expect(isRelayableEnvelope({ ok: true, result: 1 })).toBe(false);
    expect(isRelayableEnvelope({ ok: true, result: 1, logs: "nope" })).toBe(
      false
    );
  });

  it("rejects a non-object value", () => {
    expect(isRelayableEnvelope(null)).toBe(false);
    expect(isRelayableEnvelope("ok")).toBe(false);
  });
});
