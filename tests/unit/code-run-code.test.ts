import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { VALIDATION: "VALIDATION" },
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op mock
  logUserError: () => {},
}));

import {
  type RunCodeCoreInput,
  type RunCodeInput,
  runCodeStep,
} from "@/plugins/code/steps/run-code";

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type SuccessResult = {
  success: true;
  result: unknown;
  logs: Array<{ level: string; args: unknown[] }>;
};

type FailureResult = {
  success: false;
  error: string;
  logs: Array<{ level: string; args: unknown[] }>;
  line?: number;
};

type RunCodeResult = SuccessResult | FailureResult;

function makeInput(overrides: Partial<RunCodeCoreInput>): RunCodeInput {
  return {
    code: "",
    ...overrides,
  } as RunCodeInput;
}

async function run(
  overrides: Partial<RunCodeCoreInput>
): Promise<RunCodeResult> {
  return (await runCodeStep(makeInput(overrides))) as RunCodeResult;
}

async function expectSuccess(
  overrides: Partial<RunCodeCoreInput>
): Promise<SuccessResult> {
  const result = await run(overrides);
  expect(result.success).toBe(true);
  return result as SuccessResult;
}

async function expectFailure(
  overrides: Partial<RunCodeCoreInput>
): Promise<FailureResult> {
  const result = await run(overrides);
  expect(result.success).toBe(false);
  return result as FailureResult;
}

// --- Basic Execution ---------------------------------------------------------

describe("code/run-code - basic execution", () => {
  it("returns the result of a simple expression", async () => {
    const result = await expectSuccess({ code: "return 1 + 2" });
    expect(result.result).toBe(3);
  });

  it("returns undefined when code has no return", async () => {
    const result = await expectSuccess({ code: "const x = 1;" });
    expect(result.result).toBeUndefined();
  });

  it("returns objects", async () => {
    const result = await expectSuccess({
      code: 'return { name: "test", count: 42 }',
    });
    expect(result.result).toEqual({ name: "test", count: 42 });
  });

  it("returns arrays", async () => {
    const result = await expectSuccess({
      code: "return [1, 2, 3].map(x => x * 2)",
    });
    expect(result.result).toEqual([2, 4, 6]);
  });

  it("supports await at top level", async () => {
    const result = await expectSuccess({
      code: "const val = await Promise.resolve(99); return val;",
    });
    expect(result.result).toBe(99);
  });

  it("supports multiline code", async () => {
    const code = [
      "const items = [10, 20, 30];",
      "const total = items.reduce((s, v) => s + v, 0);",
      "return { total, count: items.length };",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toEqual({ total: 60, count: 3 });
  });
});

// --- BigInt Support -----------------------------------------------------------

describe("code/run-code - BigInt support", () => {
  it("creates and returns BigInt values", async () => {
    const result = await expectSuccess({
      code: "return BigInt('9007199254740993')",
    });
    expect(result.result).toBe(BigInt("9007199254740993"));
  });

  it("performs BigInt arithmetic", async () => {
    const code = [
      "const a = BigInt('9007199254740993');",
      "const b = BigInt('9007199254740994');",
      "return a + b;",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toBe(BigInt("18014398509481987"));
  });

  it("uses BigInt literals", async () => {
    const result = await expectSuccess({
      code: "return 123456789012345678901234567890n;",
    });
    expect(result.result).toBe(BigInt("123456789012345678901234567890"));
  });

  it("compares BigInt values", async () => {
    const code = [
      "const wei = BigInt('1000000000000000000');",
      "const threshold = BigInt('500000000000000000');",
      "return wei > threshold;",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toBe(true);
  });

  it("converts BigInt to string for JSON-safe output", async () => {
    const code = [
      "const val = BigInt('9007199254740993');",
      "return { value: val.toString(), isLarge: true };",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toEqual({
      value: "9007199254740993",
      isLarge: true,
    });
  });

  it("uses BigInt with template-resolved numeric values", async () => {
    const code = [
      "const amount = 1000000000000000000;",
      "const threshold = BigInt('500000000000000000');",
      "return BigInt(amount) > threshold;",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toBe(true);
  });
});

// --- Console Capture ---------------------------------------------------------

describe("code/run-code - console capture", () => {
  it("captures console.log", async () => {
    const result = await expectSuccess({
      code: 'console.log("hello"); return true;',
    });
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toEqual({ level: "log", args: ["hello"] });
  });

  it("captures console.warn and console.error", async () => {
    const code = [
      'console.warn("warning");',
      'console.error("error");',
      "return true;",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.logs).toHaveLength(2);
    expect(result.logs[0].level).toBe("warn");
    expect(result.logs[1].level).toBe("error");
  });

  it("captures multiple arguments", async () => {
    const result = await expectSuccess({
      code: 'console.log("count:", 42, true); return true;',
    });
    expect(result.logs[0].args).toEqual(["count:", 42, true]);
  });
});

// --- Sandbox Globals ---------------------------------------------------------

describe("code/run-code - sandbox globals", () => {
  it("has access to JSON", async () => {
    const result = await expectSuccess({
      code: "return JSON.parse('{\"a\":1}');",
    });
    expect(result.result).toEqual({ a: 1 });
  });

  it("has access to Math", async () => {
    const result = await expectSuccess({ code: "return Math.max(1, 5, 3)" });
    expect(result.result).toBe(5);
  });

  it("has access to Date", async () => {
    const result = await expectSuccess({
      code: "return typeof new Date().getTime()",
    });
    expect(result.result).toBe("number");
  });

  it("has access to Map and Set", async () => {
    const code = [
      "const m = new Map();",
      "m.set('a', 1);",
      "const s = new Set([1, 2, 3]);",
      "return { mapSize: m.size, setSize: s.size };",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toEqual({ mapSize: 1, setSize: 3 });
  });

  it("has access to RegExp", async () => {
    const result = await expectSuccess({
      code: 'return /^hello/.test("hello world");',
    });
    expect(result.result).toBe(true);
  });

  it("has access to parseInt and parseFloat", async () => {
    const result = await expectSuccess({
      code: 'return { int: parseInt("42"), float: parseFloat("3.14") };',
    });
    expect(result.result).toEqual({ int: 42, float: 3.14 });
  });

  it("has access to encoding functions", async () => {
    const result = await expectSuccess({
      code: 'return encodeURIComponent("hello world");',
    });
    expect(result.result).toBe("hello%20world");
  });

  it("has access to fetch", async () => {
    const result = await expectSuccess({
      code: "return typeof fetch;",
    });
    expect(result.result).toBe("function");
  });

  it("has access to URL and URLSearchParams", async () => {
    const code = [
      "const u = new URL('https://example.com/path?a=1');",
      "u.searchParams.set('b', '2');",
      "return u.toString();",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toBe("https://example.com/path?a=1&b=2");
  });

  it("has access to atob and btoa", async () => {
    const code = [
      "const encoded = btoa('hello');",
      "const decoded = atob(encoded);",
      "return { encoded, decoded };",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toEqual({ encoded: "aGVsbG8=", decoded: "hello" });
  });

  it("has access to TextEncoder and TextDecoder", async () => {
    const code = [
      "const encoder = new TextEncoder();",
      "const bytes = encoder.encode('hi');",
      "const decoder = new TextDecoder();",
      "return decoder.decode(bytes);",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toBe("hi");
  });

  it("has access to structuredClone", async () => {
    const code = [
      "const obj = { a: 1, b: [2, 3] };",
      "const clone = structuredClone(obj);",
      "clone.b.push(4);",
      "return { original: obj.b.length, cloned: clone.b.length };",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toEqual({ original: 2, cloned: 3 });
  });

  it("has access to Uint8Array", async () => {
    const result = await expectSuccess({
      code: "return new Uint8Array([0xff, 0x00, 0xab]).length;",
    });
    expect(result.result).toBe(3);
  });

  it("crypto.randomUUID returns a valid UUID string", async () => {
    const result = await expectSuccess({
      code: "return crypto.randomUUID();",
    });
    expect(result.result).toMatch(UUID_V4_REGEX);
  });

  it("crypto.randomUUID returns unique values on each call", async () => {
    const result = await expectSuccess({
      code: "const a = crypto.randomUUID(); const b = crypto.randomUUID(); return { a, b, different: a !== b };",
    });
    const r = result.result as { a: string; b: string; different: boolean };
    expect(r.different).toBe(true);
  });

  it("crypto only exposes randomUUID", async () => {
    const result = await expectSuccess({
      code: "return Object.keys(crypto);",
    });
    expect(result.result).toEqual(["randomUUID"]);
  });

  it("crypto.subtle is not available", async () => {
    const result = await expectSuccess({
      code: "return typeof crypto.subtle;",
    });
    expect(result.result).toBe("undefined");
  });

  it("crypto.getRandomValues is not available", async () => {
    const result = await expectSuccess({
      code: "return typeof crypto.getRandomValues;",
    });
    expect(result.result).toBe("undefined");
  });

  it("has access to AbortController", async () => {
    const result = await expectSuccess({
      code: "const ac = new AbortController(); return typeof ac.signal;",
    });
    expect(result.result).toBe("object");
  });

  it("has access to Intl", async () => {
    const result = await expectSuccess({
      code: "return new Intl.NumberFormat('en-US').format(1234567.89);",
    });
    expect(result.result).toBe("1,234,567.89");
  });

  it("has access to Error types", async () => {
    const result = await expectFailure({
      code: "throw new TypeError('bad type');",
    });
    expect(result.error).toContain("bad type");
  });

  it("does not have access to require", async () => {
    const result = await expectFailure({ code: 'require("fs")' });
    expect(result.error).toContain("require is not defined");
  });

  it("does not have access to process", async () => {
    const result = await expectFailure({ code: "return process.env" });
    expect(result.error).toContain("process is not defined");
  });

  it("does not expose SharedArrayBuffer in sandbox context", async () => {
    const result = await expectSuccess({
      code: "return typeof SharedArrayBuffer;",
    });
    expect(result.result).toBe("undefined");
  });

  it("does not have access to setTimeout", async () => {
    const result = await expectFailure({
      code: "setTimeout(() => {}, 100);",
    });
    expect(result.error).toContain("setTimeout is not defined");
  });

  // --- Sandbox escape: env scrubbing ----------------------------------------
  //
  // node:vm is not a security boundary -- `Error.constructor("return process")()`
  // reaches the host `process` via the primordial chain. The mitigation is to
  // run user code in a separate child node process whose env is scrubbed, so
  // the escape returns an empty env instead of pod secrets.

  it("Error.constructor escape returns a scrubbed env, not host secrets", async () => {
    const marker = "KEEPERHUB_SCRUB_TEST_SECRET_SHOULD_NOT_LEAK";
    const markerValue = `leaked-${Date.now().toString(36)}`;
    process.env[marker] = markerValue;
    try {
      const result = await expectSuccess({
        code: `
          const proc = Error.constructor("return process")();
          return {
            hasMarker: Object.prototype.hasOwnProperty.call(proc.env, ${JSON.stringify(marker)}),
            markerValue: proc.env[${JSON.stringify(marker)}] ?? null,
            envKeyCount: Object.keys(proc.env).length,
            envKeys: Object.keys(proc.env).sort(),
          };
        `,
      });
      const out = result.result as {
        hasMarker: boolean;
        markerValue: string | null;
        envKeyCount: number;
        envKeys: string[];
      };
      expect(out.hasMarker).toBe(false);
      expect(out.markerValue).toBeNull();
      // Sanity: none of the known high-value secret keys may appear.
      const mustNotLeak = new Set([
        marker,
        "AGENTIC_WALLET_HMAC_KMS_KEY",
        "WALLET_ENCRYPTION_KEY",
        "INTEGRATION_ENCRYPTION_KEY",
        "TURNKEY_API_PRIVATE_KEY",
        "REGISTRATION_PRIVATE_KEY",
        "CDP_API_KEY_SECRET",
        "MPP_SECRET_KEY",
        "DATABASE_URL",
        "BETTER_AUTH_SECRET",
        "OAUTH_JWT_SECRET",
        "MCP_SESSION_SECRET",
        "STRIPE_SECRET_KEY",
        "GITHUB_CLIENT_SECRET",
        "GOOGLE_CLIENT_SECRET",
      ]);
      for (const key of out.envKeys) {
        expect(mustNotLeak.has(key)).toBe(false);
      }
    } finally {
      delete process.env[marker];
    }
  });

  // A worker_threads.Worker shares the OS process with the parent, so
  // /proc/self/environ still contains the parent's full env. A separate child
  // process started via execve has an OS-level environ matching only the
  // allowlist. This test exercises the deeper hole: fs.readFileSync on
  // /proc/self/environ inside the escape must not leak the parent's env.
  // Skipped on non-Linux because /proc/self/environ does not exist.
  const maybeSkip = process.platform === "linux" ? it : it.skip;
  maybeSkip(
    "fs.readFileSync('/proc/self/environ') in the escape cannot see host env",
    async () => {
      const marker = "KEEPERHUB_PROC_ENVIRON_SENTINEL_SHOULD_NOT_LEAK";
      const markerValue = `leaked-${Date.now().toString(36)}`;
      process.env[marker] = markerValue;
      try {
        const result = await expectSuccess({
          code: `
            const proc = Error.constructor("return process")();
            // mainModule.require is the canonical post-escape path to fs in
            // script-mode node ('node -e ...'). If this ever starts returning
            // a non-null value that contains the marker, the env scrub is
            // broken at the OS level.
            const mod = proc.mainModule;
            const req = mod && typeof mod.require === "function" ? mod.require : null;
            if (!req) {
              return { reachedFs: false, hasMarker: false, environLen: 0 };
            }
            const fs = req("fs");
            const environ = fs.readFileSync("/proc/self/environ", "utf8");
            return {
              reachedFs: true,
              hasMarker: environ.indexOf(${JSON.stringify(marker)}) !== -1,
              hasMarkerValue: environ.indexOf(${JSON.stringify(markerValue)}) !== -1,
              environLen: environ.length,
            };
          `,
        });
        const out = result.result as {
          reachedFs: boolean;
          hasMarker: boolean;
          hasMarkerValue?: boolean;
          environLen: number;
        };
        // Either the escape could not reach fs (defence in depth) or the
        // environ it read was the child's scrubbed one (our primary claim).
        if (out.reachedFs) {
          expect(out.hasMarker).toBe(false);
          expect(out.hasMarkerValue).toBe(false);
        }
      } finally {
        delete process.env[marker];
      }
    }
  );

  it("blocks fetch to cloud metadata endpoints", async () => {
    const result = await expectFailure({
      code: 'await fetch("http://169.254.169.254/latest/meta-data/")',
    });
    expect(result.error).toContain("SSRF blocked");
  });

  it("blocks fetch to RFC 1918 private IPv4 literals", async () => {
    const result = await expectFailure({
      code: 'await fetch("http://10.0.0.1/")',
    });
    expect(result.error).toContain("SSRF blocked");
  });

  it("blocks fetch to NAT64-wrapped link-local IPv4 (IMDS via 64:ff9b::/96)", async () => {
    // 64:ff9b::a9fe:a9fe -> 169.254.169.254 (IMDS). The NAT64 wrapper
    // must not bypass the IPv4 link-local denylist.
    const result = await expectFailure({
      code: 'await fetch("http://[64:ff9b::a9fe:a9fe]/")',
    });
    expect(result.error).toContain("SSRF blocked");
  });

  it("blocks fetch to NAT64-wrapped RFC 1918 IPv4", async () => {
    // 64:ff9b::a00:1 -> 10.0.0.1. Same recheck must catch this.
    const result = await expectFailure({
      code: 'await fetch("http://[64:ff9b::a00:1]/")',
    });
    expect(result.error).toContain("SSRF blocked");
  });

  it("blocks fetch to a hostname that resolves to loopback", async () => {
    const result = await expectFailure({
      code: 'await fetch("http://localhost/")',
    });
    expect(result.error).toContain("SSRF blocked");
  });

  it("rejects fetch with a non-http(s) scheme", async () => {
    const result = await expectFailure({
      code: 'await fetch("file:///etc/passwd")',
    });
    expect(result.error).toContain("scheme not allowed");
  });
});

// --- Error Handling ----------------------------------------------------------

describe("code/run-code - error handling", () => {
  it("fails with empty code", async () => {
    const result = await expectFailure({ code: "" });
    expect(result.error).toBe("No code provided");
  });

  it("fails with whitespace-only code", async () => {
    const result = await expectFailure({ code: "   " });
    expect(result.error).toBe("No code provided");
  });

  it("reports syntax errors", async () => {
    const result = await expectFailure({ code: "return {;" });
    expect(result.error).toContain("Code execution failed");
  });

  it("reports runtime errors", async () => {
    const code = [
      "const x = 1;",
      "const y = 2;",
      "throw new Error('oops');",
    ].join("\n");
    const result = await expectFailure({ code });
    expect(result.error).toContain("oops");
  });

  it("extracts line number from runtime error", async () => {
    const code = [
      "const x = 1;",
      "const y = 2;",
      "throw new Error('line 3');",
    ].join("\n");
    const result = await expectFailure({ code });
    expect(result.line).toBe(3);
  });

  it("extracts line 1 for error on first line", async () => {
    const result = await expectFailure({ code: "throw new Error('first');" });
    expect(result.line).toBe(1);
  });

  it("detects unresolved stored-format templates", async () => {
    const result = await expectFailure({
      code: "return {{@node1:Label.field}};",
    });
    expect(result.error).toContain("Unresolved template variables");
  });

  it("detects unresolved display-format templates", async () => {
    const result = await expectFailure({
      code: "return {{Label.field}};",
    });
    expect(result.error).toContain("Unresolved template variables");
  });

  it("allows {{...}} inside double-quoted strings", async () => {
    const result = await expectSuccess({
      code: 'return "Use {{name}} for templates";',
    });
    expect(result.result).toBe("Use {{name}} for templates");
  });

  it("allows {{...}} inside single-quoted strings", async () => {
    const result = await expectSuccess({
      code: "return 'Value is {{placeholder}}';",
    });
    expect(result.result).toBe("Value is {{placeholder}}");
  });

  it("allows {{...}} inside backtick strings", async () => {
    const result = await expectSuccess({
      code: "return `template: {{var}}`;",
    });
    expect(result.result).toBe("template: {{var}}");
  });

  it("still detects unresolved templates outside strings", async () => {
    const result = await expectFailure({
      code: 'const s = "safe {{inside}}"; return {{Outside.field}};',
    });
    expect(result.error).toContain("Unresolved template variables");
  });

  it("allows {{...}} inside line comments", async () => {
    const result = await expectSuccess({
      code: "// const x = {{Commented.result}};\nreturn 1;",
    });
    expect(result.result).toBe(1);
  });

  it("allows {{...}} inside block comments", async () => {
    const result = await expectSuccess({
      code: "/* const x = {{A.result}};\nconst y = {{B.result}}; */\nreturn 2;",
    });
    expect(result.result).toBe(2);
  });

  it("still detects unresolved templates outside comments", async () => {
    const result = await expectFailure({
      code: "/* const x = {{Commented.result}}; */\nreturn {{Outside.field}};",
    });
    expect(result.error).toContain("Unresolved template variables");
    expect(result.error).not.toContain("{{Commented.result}}");
  });

  it("preserves console logs even on error", async () => {
    const code = [
      'console.log("before error");',
      "throw new Error('fail');",
    ].join("\n");
    const result = await expectFailure({ code });
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].args).toEqual(["before error"]);
  });
});

// --- Real-World Patterns -----------------------------------------------------
// These mirror the example workflows from docs/plugins/code.md to ensure the
// sandbox supports the data transformations users will actually write.

describe("code/run-code - data transformation patterns", () => {
  it("filters and aggregates event data with BigInt", async () => {
    const code = [
      "const events = [",
      "  { from: '0xabc', value: '2000000000000000000' },",
      "  { from: '0xdef', value: '500000000000000000' },",
      "  { from: '0x123', value: '3000000000000000000' },",
      "];",
      "const threshold = BigInt('1000000000000000000');",
      "const large = events.filter(e => BigInt(e.value) > threshold);",
      "const total = large.reduce((sum, e) => sum + BigInt(e.value), 0n);",
      "return {",
      "  count: large.length,",
      "  total: total.toString(),",
      "  addresses: large.map(e => e.from)",
      "};",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toEqual({
      count: 2,
      total: "5000000000000000000",
      addresses: ["0xabc", "0x123"],
    });
  });

  it("deduplicates events using Set", async () => {
    const code = [
      "const events = [",
      "  { txHash: '0xaa', value: 100 },",
      "  { txHash: '0xbb', value: 200 },",
      "  { txHash: '0xaa', value: 100 },",
      "  { txHash: '0xcc', value: 300 },",
      "];",
      "const seen = new Set();",
      "const unique = events.filter(e => {",
      "  if (seen.has(e.txHash)) return false;",
      "  seen.add(e.txHash);",
      "  return true;",
      "});",
      "return { total: unique.length, removed: events.length - unique.length };",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toEqual({ total: 3, removed: 1 });
  });

  it("sorts and takes top-N results", async () => {
    const code = [
      "const items = [",
      "  { name: 'a', value: 10 },",
      "  { name: 'b', value: 50 },",
      "  { name: 'c', value: 30 },",
      "  { name: 'd', value: 90 },",
      "  { name: 'e', value: 20 },",
      "];",
      "items.sort((a, b) => b.value - a.value);",
      "return items.slice(0, 3).map(i => i.name);",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toEqual(["d", "b", "c"]);
  });

  it("joins data from multiple sources", async () => {
    const code = [
      "const addresses = [",
      "  { label: 'Treasury', address: '0xaaa' },",
      "  { label: 'Hot Wallet', address: '0xbbb' },",
      "];",
      "const balances = ['2000000000000000000', '500000000000000000'];",
      "const report = addresses.map((addr, i) => ({",
      "  label: addr.label,",
      "  balance: (Number(balances[i]) / 1e18).toFixed(4)",
      "}));",
      "return report;",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toEqual([
      { label: "Treasury", balance: "2.0000" },
      { label: "Hot Wallet", balance: "0.5000" },
    ]);
  });

  it("computes z-score for anomaly detection", async () => {
    const code = [
      "const history = [100, 102, 98, 101, 99, 103, 97];",
      "const current = 150;",
      "const mean = history.reduce((s, v) => s + v, 0) / history.length;",
      "const variance = history.reduce((s, v) => s + (v - mean) ** 2, 0) / history.length;",
      "const stdDev = Math.sqrt(variance);",
      "const zScore = Math.abs((current - mean) / stdDev);",
      "return { isAnomaly: zScore > 3, zScore: parseFloat(zScore.toFixed(2)) };",
    ].join("\n");
    const result = await expectSuccess({ code });
    const r = result.result as { isAnomaly: boolean; zScore: number };
    expect(r.isAnomaly).toBe(true);
    expect(r.zScore).toBeGreaterThan(3);
  });

  it("builds formatted alert messages", async () => {
    const code = [
      "const wallet = '0xabc123';",
      "const balance = 1.5;",
      "const threshold = 2.0;",
      "const timestamp = '2024-01-15T10:30:00Z';",
      "const msg = [",
      "  'Wallet: ' + wallet,",
      "  'Balance: ' + balance + ' ETH',",
      "  'Threshold: ' + threshold + ' ETH',",
      "  'Time: ' + timestamp,",
      "].join('\\n');",
      "return { message: msg, shouldAlert: balance < threshold };",
    ].join("\n");
    const result = await expectSuccess({ code });
    const r = result.result as { message: string; shouldAlert: boolean };
    expect(r.shouldAlert).toBe(true);
    expect(r.message).toContain("Wallet: 0xabc123");
    expect(r.message).toContain("Balance: 1.5 ETH");
  });

  it("transforms webhook payload with base64 encoding", async () => {
    const code = [
      "const alerts = [",
      "  { severity: 'critical', name: 'HighGas' },",
      "  { severity: 'warning', name: 'LowBalance' },",
      "  { severity: 'critical', name: 'OracleDown' },",
      "];",
      "const critical = alerts.filter(a => a.severity === 'critical');",
      "const encoded = btoa(JSON.stringify(critical));",
      "return { count: critical.length, encoded };",
    ].join("\n");
    const result = await expectSuccess({ code });
    const r = result.result as { count: number; encoded: string };
    expect(r.count).toBe(2);
    const decoded = JSON.parse(atob(r.encoded));
    expect(decoded).toHaveLength(2);
    expect(decoded[0].name).toBe("HighGas");
  });

  it("formats numbers with Intl for human-readable output", async () => {
    const code = [
      "const wei = '1234567890000000000';",
      "const eth = Number(wei) / 1e18;",
      "const formatted = new Intl.NumberFormat('en-US', {",
      "  minimumFractionDigits: 4,",
      "  maximumFractionDigits: 4,",
      "}).format(eth);",
      "return formatted;",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toBe("1.2346");
  });

  it("uses URL to build query strings for API calls", async () => {
    const code = [
      "const base = 'https://api.example.com/v1/prices';",
      "const url = new URL(base);",
      "url.searchParams.set('ids', 'ethereum,bitcoin');",
      "url.searchParams.set('vs_currencies', 'usd');",
      "return url.toString();",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toBe(
      "https://api.example.com/v1/prices?ids=ethereum%2Cbitcoin&vs_currencies=usd"
    );
  });

  it("uses structuredClone for safe mutation", async () => {
    const code = [
      "const original = { users: [{ name: 'Alice', score: 10 }] };",
      "const modified = structuredClone(original);",
      "modified.users[0].score = 99;",
      "modified.users.push({ name: 'Bob', score: 50 });",
      "return {",
      "  originalCount: original.users.length,",
      "  modifiedCount: modified.users.length,",
      "  originalScore: original.users[0].score,",
      "};",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toEqual({
      originalCount: 1,
      modifiedCount: 2,
      originalScore: 10,
    });
  });
});

describe("code/run-code - async patterns", () => {
  it("uses Promise.all for parallel operations", async () => {
    const code = [
      "const results = await Promise.all([",
      "  Promise.resolve(1),",
      "  Promise.resolve(2),",
      "  Promise.resolve(3),",
      "]);",
      "return results.reduce((s, v) => s + v, 0);",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toBe(6);
  });

  it("handles async error with try/catch", async () => {
    const code = [
      "try {",
      "  await Promise.reject(new Error('network error'));",
      "} catch (e) {",
      "  return { caught: true, message: e.message };",
      "}",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toEqual({
      caught: true,
      message: "network error",
    });
  });

  it("defines and calls inner async functions", async () => {
    const code = [
      "async function fetchData(id) {",
      "  return await Promise.resolve({ id, value: id * 10 });",
      "}",
      "const a = await fetchData(1);",
      "const b = await fetchData(2);",
      "return [a, b];",
    ].join("\n");
    const result = await expectSuccess({ code });
    expect(result.result).toEqual([
      { id: 1, value: 10 },
      { id: 2, value: 20 },
    ]);
  });
});

// --- Timeout -----------------------------------------------------------------

describe("code/run-code - timeout", () => {
  it("uses custom timeout", async () => {
    const result = await expectSuccess({
      code: "return true;",
      timeout: 5,
    });
    expect(result.result).toBe(true);
  });

  it("clamps timeout to max 120 seconds", async () => {
    const result = await expectSuccess({
      code: "return true;",
      timeout: 999,
    });
    expect(result.result).toBe(true);
  });

  it("wall-clock timeout catches hanging async operations", async () => {
    const result = await expectFailure({
      code: "await new Promise(() => {});",
      timeout: 1,
    });
    expect(result.error).toContain("timed out after 1 second");
  }, 10_000);

  it("clamps timeout to min 1 second", async () => {
    const result = await expectSuccess({
      code: "return true;",
      timeout: 0,
    });
    expect(result.result).toBe(true);
  });
});
