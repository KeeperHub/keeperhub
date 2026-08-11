import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  encodeSandboxResult,
  SANDBOX_WIRE_VERSION,
} from "@/lib/sandbox/child-source";

vi.mock("server-only", () => ({}));

const RESULT_SENTINEL = "\u0001RESULT\u0002";

type MockResponder = (req: { body: unknown }) => {
  status: number;
  body: string;
  headers?: Record<string, string>;
};

let port = 0;
let server: Server;
let currentResponder: MockResponder | null = null;
let connectionCount = 0;

async function readReqBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function decodeRunPayload(raw: Buffer): unknown {
  return JSON.parse(raw.toString("utf8"));
}

beforeAll(async () => {
  server = createServer(
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const body = await readReqBody(req);
      const parsed = decodeRunPayload(body);
      if (!currentResponder) {
        res.writeHead(500);
        res.end("no responder registered");
        return;
      }
      const result = currentResponder({ body: parsed });
      res.writeHead(result.status, {
        "Content-Type": "application/octet-stream",
        "X-KH-Sandbox-Wire": SANDBOX_WIRE_VERSION,
        ...result.headers,
      });
      res.end(result.body);
    }
  );

  server.on("connection", () => {
    connectionCount += 1;
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  port = addr.port;
  process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  delete process.env.SANDBOX_URL;
});

function sentinelBody(outcome: unknown): string {
  return `${RESULT_SENTINEL}${encodeSandboxResult(outcome)}\n`;
}

describe("lib/sandbox-client runRemote", () => {
  it("returns success:true for a valid ok:true ChildOutcome response", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: sentinelBody({ ok: true, result: 2, logs: [] }),
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "return 1 + 1;", timeoutMs: 5000 });
    expect(outcome).toEqual({ success: true, result: 2, logs: [] });
  });

  it("round-trips BigInt across the wire", async () => {
    const big = BigInt("1267650600228229401496703205376");
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: sentinelBody({ ok: true, result: big, logs: [] }),
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "doesnt matter", timeoutMs: 1000 });
    expect(outcome.success).toBe(true);
    if (outcome.success) {
      expect(outcome.result).toBe(big);
    }
  });

  it("maps ok:false to success:false with error message and line number", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: sentinelBody({
        ok: false,
        errorMessage: "boom",
        errorStack: "Error: boom\n    at user-code.js:4",
        logs: [],
      }),
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({
      code: "throw new Error('boom');",
      timeoutMs: 1000,
    });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error).toBe("boom");
      expect(outcome.line).toBe(3);
    }
  });

  it("reuses a single TCP socket across N sequential runRemote calls (keep-alive)", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: sentinelBody({ ok: true, result: 0, logs: [] }),
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const startConnections = connectionCount;
    for (const _iteration of [1, 2, 3, 4, 5]) {
      await runRemote({ code: "return 0;", timeoutMs: 1000 });
    }
    const delta = connectionCount - startConnections;
    expect(delta).toBeLessThanOrEqual(1);
  });

  it("returns success:false when sandbox is unreachable (no throw)", async () => {
    const saved = process.env.SANDBOX_URL;
    process.env.SANDBOX_URL = "http://127.0.0.1:1";
    try {
      vi.resetModules();
      const { runRemote } = await import("@/lib/sandbox/client");
      const outcome = await runRemote({
        code: "return 1;",
        timeoutMs: 1000,
      });
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error).toContain("sandbox client error");
      }
    } finally {
      process.env.SANDBOX_URL = saved;
      vi.resetModules();
    }
  });

  it("uses lastIndexOf to tolerate forged sentinels earlier in output", async () => {
    const fakePayload = "garbage-not-json-payload";
    const realPayload = encodeSandboxResult({
      ok: true,
      result: "real",
      logs: [],
    });
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: `noise${RESULT_SENTINEL}${fakePayload}\n${RESULT_SENTINEL}${realPayload}\n`,
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "x", timeoutMs: 1000 });
    expect(outcome.success).toBe(true);
    if (outcome.success) {
      expect(outcome.result).toBe("real");
    }
  });

  it("sends timeout in SECONDS in the JSON payload", async () => {
    let capturedPayload: unknown = null;
    currentResponder = ({ body }): { status: number; body: string } => {
      capturedPayload = body;
      return {
        status: 200,
        body: sentinelBody({ ok: true, result: null, logs: [] }),
      };
    };
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    await runRemote({ code: "return null;", timeoutMs: 5000 });
    expect(capturedPayload).toMatchObject({
      code: "return null;",
      timeout: 5,
    });
  });

  it("rejects immediately when the caller's AbortSignal fires mid-request", async () => {
    const hangingSockets: IncomingMessage[] = [];
    const hangingServer = createServer((req: IncomingMessage): void => {
      hangingSockets.push(req);
    });
    await new Promise<void>((resolve, reject) => {
      hangingServer.once("error", reject);
      hangingServer.listen(0, "127.0.0.1", () => {
        hangingServer.off("error", reject);
        resolve();
      });
    });
    const hangingPort = (hangingServer.address() as AddressInfo).port;
    const savedUrl = process.env.SANDBOX_URL;
    process.env.SANDBOX_URL = `http://127.0.0.1:${hangingPort}`;
    try {
      vi.resetModules();
      const { runRemote } = await import("@/lib/sandbox/client");
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const start = Date.now();
      const outcome = await runRemote({
        code: "return 1;",
        timeoutMs: 120_000,
        signal: controller.signal,
      });
      const elapsed = Date.now() - start;
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error).toContain("aborted");
      }
      expect(elapsed).toBeLessThan(1000);
    } finally {
      for (const req of hangingSockets) {
        req.socket.destroy();
      }
      if (savedUrl === undefined) {
        delete process.env.SANDBOX_URL;
      } else {
        process.env.SANDBOX_URL = savedUrl;
      }
      await new Promise<void>((resolve) => {
        hangingServer.close(() => resolve());
      });
      vi.resetModules();
    }
  });

  it("rejects with a timeout error when the sandbox never responds", async () => {
    const hangingSockets: IncomingMessage[] = [];
    const hangingServer = createServer((req: IncomingMessage): void => {
      hangingSockets.push(req);
    });
    await new Promise<void>((resolve, reject) => {
      hangingServer.once("error", reject);
      hangingServer.listen(0, "127.0.0.1", () => {
        hangingServer.off("error", reject);
        resolve();
      });
    });
    const hangingPort = (hangingServer.address() as AddressInfo).port;
    const savedUrl = process.env.SANDBOX_URL;
    const savedSlack = process.env.SANDBOX_HTTP_SLACK_MS;
    process.env.SANDBOX_URL = `http://127.0.0.1:${hangingPort}`;
    process.env.SANDBOX_HTTP_SLACK_MS = "50";
    try {
      vi.resetModules();
      const { runRemote } = await import("@/lib/sandbox/client");
      const start = Date.now();
      const outcome = await runRemote({ code: "return 1;", timeoutMs: 50 });
      const elapsed = Date.now() - start;
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error).toContain("sandbox client error");
        expect(outcome.error).toContain("timed out after");
      }
      // 50 ms code budget + 50 ms slack = 100 ms; allow wide margin for CI.
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      for (const req of hangingSockets) {
        req.socket.destroy();
      }
      if (savedUrl === undefined) {
        delete process.env.SANDBOX_URL;
      } else {
        process.env.SANDBOX_URL = savedUrl;
      }
      if (savedSlack === undefined) {
        delete process.env.SANDBOX_HTTP_SLACK_MS;
      } else {
        process.env.SANDBOX_HTTP_SLACK_MS = savedSlack;
      }
      await new Promise<void>((resolve) => {
        hangingServer.close(() => resolve());
      });
      vi.resetModules();
    }
  });

  it("returns success:false when response is missing the sentinel", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: "garbage without sentinel",
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "return 1;", timeoutMs: 1000 });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error).toContain("sandbox client error");
    }
  });

  it("rebuilds a __proto__ key as an own property without polluting Object.prototype", async () => {
    const before = ({} as Record<string, unknown>).polluted;
    // A hostile sandbox sends a tagged-JSON result carrying a __proto__ key.
    // decodeSandboxResult rebuilds it as an own data property (JSON.parse +
    // Object.defineProperty), never invoking the prototype setter.
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: `${RESULT_SENTINEL}{"ok":true,"result":{"__proto__":{"polluted":true}},"logs":[]}\n`,
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "x", timeoutMs: 1000 });
    expect(({} as Record<string, unknown>).polluted).toBe(before);
    expect(outcome.success).toBe(true);
    if (outcome.success) {
      const result = outcome.result as Record<string, unknown>;
      expect(Object.hasOwn(result, "__proto__")).toBe(true);
      expect(({} as Record<string, unknown>).polluted).toBe(before);
    }
  });

  it("returns a clean error (never v8) when the payload after the sentinel is not JSON", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: `${RESULT_SENTINEL}this is not json at all\n`,
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "x", timeoutMs: 1000 });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error).toContain("sandbox client error");
    }
  });

  it("rejects a well-typed-discriminant but malformed outcome (ok:false, no errorMessage)", async () => {
    // Valid tagged-JSON and a valid `ok` discriminant, but the variant fields
    // are missing -- the tightened ChildOutcome guard must reject it rather
    // than surface an undefined error/log downstream.
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: `${RESULT_SENTINEL}{"ok":false,"logs":[]}\n`,
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "x", timeoutMs: 1000 });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error).toContain("sandbox client error");
    }
  });

  it("retries a 429 capacity response and succeeds on the next attempt", async () => {
    let attempts = 0;
    currentResponder = (): {
      status: number;
      body: string;
      headers?: Record<string, string>;
    } => {
      attempts += 1;
      if (attempts === 1) {
        return {
          status: 429,
          body: "sandbox at capacity",
          headers: { "Retry-After": "0" },
        };
      }
      return {
        status: 200,
        body: sentinelBody({ ok: true, result: 7, logs: [] }),
      };
    };
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "return 7;", timeoutMs: 1000 });
    expect(attempts).toBe(2);
    expect(outcome).toEqual({ success: true, result: 7, logs: [] });
  });

  it("gives up after the bounded retries on sustained 429 and surfaces the error", async () => {
    let attempts = 0;
    currentResponder = (): {
      status: number;
      body: string;
      headers?: Record<string, string>;
    } => {
      attempts += 1;
      return {
        status: 429,
        body: "sandbox at capacity",
        headers: { "Retry-After": "0" },
      };
    };
    const saved = process.env.SANDBOX_MAX_RETRIES;
    process.env.SANDBOX_MAX_RETRIES = "2";
    try {
      vi.resetModules();
      process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
      const { runRemote } = await import("@/lib/sandbox/client");
      const outcome = await runRemote({ code: "return 1;", timeoutMs: 1000 });
      // 2 retries on top of the initial attempt = 3 requests.
      expect(attempts).toBe(3);
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error).toContain("429");
      }
    } finally {
      if (saved === undefined) {
        delete process.env.SANDBOX_MAX_RETRIES;
      } else {
        process.env.SANDBOX_MAX_RETRIES = saved;
      }
      vi.resetModules();
    }
  });

  it("does not retry a non-429 error response", async () => {
    let attempts = 0;
    currentResponder = (): { status: number; body: string } => {
      attempts += 1;
      return { status: 500, body: "sandbox internal error" };
    };
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "return 1;", timeoutMs: 1000 });
    expect(attempts).toBe(1);
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error).toContain("500");
    }
  });

  it("returns success:false when the server resets the socket mid-response-body", async () => {
    const resetSockets: IncomingMessage[] = [];
    const resetServer = createServer(
      (req: IncomingMessage, res: ServerResponse): void => {
        resetSockets.push(req);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-KH-Sandbox-Wire": SANDBOX_WIRE_VERSION,
          "Transfer-Encoding": "chunked",
        });
        res.write('RESULT{"ok":tr');
        // Destroy the socket before the body is complete.
        req.socket.destroy();
      }
    );
    await new Promise<void>((resolve, reject) => {
      resetServer.once("error", reject);
      resetServer.listen(0, "127.0.0.1", () => {
        resetServer.off("error", reject);
        resolve();
      });
    });
    const resetPort = (resetServer.address() as AddressInfo).port;
    const savedUrl = process.env.SANDBOX_URL;
    process.env.SANDBOX_URL = `http://127.0.0.1:${resetPort}`;
    try {
      vi.resetModules();
      const { runRemote } = await import("@/lib/sandbox/client");
      const outcome = await runRemote({ code: "return 1;", timeoutMs: 5000 });
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error).toContain("sandbox client error");
      }
    } finally {
      for (const req of resetSockets) {
        req.socket.destroy();
      }
      if (savedUrl === undefined) {
        delete process.env.SANDBOX_URL;
      } else {
        process.env.SANDBOX_URL = savedUrl;
      }
      await new Promise<void>((resolve) => {
        resetServer.close(() => resolve());
      });
      vi.resetModules();
    }
  });
});

describe("lib/sandbox-client runRemote untrusted-shape hardening", () => {
  it("rejects a forged non-string errorStack cleanly instead of throwing in extractLineNumber", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: sentinelBody({
        ok: false,
        errorMessage: "boom",
        errorStack: 123,
        logs: [],
      }),
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "x", timeoutMs: 1000 });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error).toContain("sandbox client error");
      // Must NOT be the "stack.match is not a function" TypeError.
      expect(outcome.error).not.toContain("match");
    }
  });

  it("rejects a forged logs array containing a non-entry", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: sentinelBody({ ok: true, result: 1, logs: [null] }),
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "x", timeoutMs: 1000 });
    expect(outcome.success).toBe(false);
  });

  it("still surfaces a valid ok:false outcome and extracts the line number", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: sentinelBody({
        ok: false,
        errorMessage: "kaboom",
        errorStack: "Error: kaboom\n    at user-code.js:6:7",
        logs: [],
      }),
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "x", timeoutMs: 1000 });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error).toBe("kaboom");
      expect(outcome.line).toBe(5);
    }
  });
});

describe("lib/sandbox-client runRemote response size cap", () => {
  it("rejects a response body that exceeds SANDBOX_MAX_RESPONSE_BYTES", async () => {
    const oversized = `${RESULT_SENTINEL}${"x".repeat(200_000)}\n`;
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: oversized,
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    process.env.SANDBOX_MAX_RESPONSE_BYTES = "1024";
    try {
      const { runRemote } = await import("@/lib/sandbox/client");
      const outcome = await runRemote({ code: "x", timeoutMs: 1000 });
      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error).toContain("exceeds maximum size");
      }
    } finally {
      delete process.env.SANDBOX_MAX_RESPONSE_BYTES;
    }
  });
});

describe("lib/sandbox-client runRemote wire-version skew", () => {
  it("rejects a 200 response whose X-KH-Sandbox-Wire header does not match", async () => {
    currentResponder = (): {
      status: number;
      body: string;
      headers: Record<string, string>;
    } => ({
      status: 200,
      body: sentinelBody({ ok: true, result: 1, logs: [] }),
      // Simulate an older sandbox advertising a different wire version.
      headers: { "X-KH-Sandbox-Wire": "json-v0" },
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    const { runRemote } = await import("@/lib/sandbox/client");
    const outcome = await runRemote({ code: "x", timeoutMs: 1000 });
    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error).toContain("wire version mismatch");
    }
  });
});

describe("lib/sandbox-client runRemote env override guards", () => {
  it("ignores a negative SANDBOX_MAX_RESPONSE_BYTES instead of rejecting every response", async () => {
    currentResponder = (): { status: number; body: string } => ({
      status: 200,
      body: sentinelBody({ ok: true, result: 7, logs: [] }),
    });
    vi.resetModules();
    process.env.SANDBOX_URL = `http://127.0.0.1:${port}`;
    process.env.SANDBOX_MAX_RESPONSE_BYTES = "-1";
    try {
      const { runRemote } = await import("@/lib/sandbox/client");
      const outcome = await runRemote({ code: "x", timeoutMs: 1000 });
      expect(outcome.success).toBe(true);
      if (outcome.success) {
        expect(outcome.result).toBe(7);
      }
    } finally {
      delete process.env.SANDBOX_MAX_RESPONSE_BYTES;
    }
  });
});
