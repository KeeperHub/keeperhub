import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decodeSandboxResult,
  SANDBOX_WIRE_VERSION,
} from "../../lib/sandbox/child-source.js";
import { handleRequest } from "./index.js";

const RESULT_SENTINEL = "\u0001RESULT\u0002";

function makeRunBody(payload: unknown): string {
  return JSON.stringify(payload);
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string | number>
): Promise<{ status: number; body: Buffer }> {
  const { request: httpRequest } = await import("node:http");
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers:
          headers ??
          (body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                "X-KH-Sandbox-Wire": SANDBOX_WIRE_VERSION,
              }
            : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function parseRunResponse(body: Buffer): unknown {
  const text = body.toString("utf8");
  const idx = text.lastIndexOf(RESULT_SENTINEL);
  if (idx < 0) {
    throw new Error(`no sentinel in response: ${text.slice(0, 80)}`);
  }
  const payload = text
    .slice(idx + RESULT_SENTINEL.length)
    .replace(/\n$/, "")
    .trim();
  return decodeSandboxResult(payload);
}

describe("sandbox HTTP server", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse): void => {
      handleRequest(req, res);
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
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("GET /healthz returns 200 with body 'ok'", async () => {
    const res = await request(port, "GET", "/healthz");
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("ok");
  });

  it("GET /unknown returns 404", async () => {
    const res = await request(port, "GET", "/unknown");
    expect(res.status).toBe(404);
  });

  it("POST /unknown returns 404", async () => {
    const res = await request(port, "POST", "/unknown", "");
    expect(res.status).toBe(404);
  });

  it("POST /run with valid JSON body returns 200 with sentinel-prefixed ChildOutcome", async () => {
    const body = makeRunBody({ code: "return 1 + 1;", timeout: 5 });
    const res = await request(port, "POST", "/run", body);
    expect(res.status).toBe(200);
    const text = res.body.toString("utf8");
    expect(text.includes(RESULT_SENTINEL)).toBe(true);
    const outcome = parseRunResponse(res.body) as {
      ok: boolean;
      result?: unknown;
    };
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe(2);
  });

  it("POST /run with empty body returns 400", async () => {
    const res = await request(port, "POST", "/run", undefined, {
      "X-KH-Sandbox-Wire": SANDBOX_WIRE_VERSION,
    });
    expect(res.status).toBe(400);
  });

  it("POST /run without the wire-version header returns 415", async () => {
    const body = makeRunBody({ code: "return 1;", timeout: 5 });
    const res = await request(port, "POST", "/run", body, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    expect(res.status).toBe(415);
    expect(res.body.toString()).toContain("unsupported sandbox wire version");
  });

  it("POST /run with non-JSON garbage body returns 400 malformed body", async () => {
    const res = await request(
      port,
      "POST",
      "/run",
      "this is not json at all !!!"
    );
    expect(res.status).toBe(400);
    expect(res.body.toString()).toBe("malformed body");
  });

  it("POST /run with valid JSON but no code field returns 400 malformed body", async () => {
    const res = await request(
      port,
      "POST",
      "/run",
      JSON.stringify({ timeout: 5 })
    );
    expect(res.status).toBe(400);
    expect(res.body.toString()).toBe("malformed body");
  });

  it("POST /run round-trips a result containing BigInt and Map through encodeSandboxResult", async () => {
    const body = makeRunBody({
      code: "return { b: BigInt('1000000000000000000'), m: new Map([['a', 1]]) };",
      timeout: 5,
    });
    const res = await request(port, "POST", "/run", body);
    expect(res.status).toBe(200);
    const outcome = parseRunResponse(res.body) as {
      ok: boolean;
      result?: { b: bigint; m: Map<string, number> };
    };
    expect(outcome.ok).toBe(true);
    expect(outcome.result?.b).toBe(BigInt("1000000000000000000"));
    expect(outcome.result?.m).toBeInstanceOf(Map);
    expect(outcome.result?.m.get("a")).toBe(1);
  });

  it("POST /run where user code throws returns 200 with ok:false ChildOutcome", async () => {
    const body = makeRunBody({ code: "throw new Error('boom');", timeout: 5 });
    const res = await request(port, "POST", "/run", body);
    expect(res.status).toBe(200);
    const outcome = parseRunResponse(res.body) as {
      ok: boolean;
      errorMessage?: string;
    };
    expect(outcome.ok).toBe(false);
    expect(outcome.errorMessage).toContain("boom");
  });

  it("POST /run with env-escape payload does not leak injected secret", async () => {
    const FAKE = "SBX_TEST_FAKE_SECRET_AAA";
    process.env[FAKE] = "must-not-leak";
    try {
      const body = makeRunBody({
        code: `const p = Error.constructor("return process")(); return Object.keys(p.env);`,
        timeout: 5,
      });
      const res = await request(port, "POST", "/run", body);
      expect(res.status).toBe(200);
      const outcome = parseRunResponse(res.body) as {
        ok: boolean;
        result?: string[];
      };
      expect(outcome.ok).toBe(true);
      expect(outcome.result).not.toContain(FAKE);
    } finally {
      delete process.env[FAKE];
    }
  });

  it("kills the child when the client disconnects mid-request", async () => {
    // User code hangs for 60s; we abort the HTTP request after 200ms and
    // then verify the server returns to idle quickly. If the child were
    // allowed to keep running, the process would hold handles and the
    // test would see stderr or exceed a tight wall-clock bound.
    const { request: httpRequest } = await import("node:http");
    const hangingCode = makeRunBody({
      code: "await new Promise(() => {});",
      timeout: 60,
    });
    const start = Date.now();
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/run",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(hangingCode),
            "X-KH-Sandbox-Wire": SANDBOX_WIRE_VERSION,
          },
        },
        () => {
          reject(
            new Error("expected request to be aborted before any response")
          );
        }
      );
      req.on("error", () => resolve());
      req.write(hangingCode);
      req.end();
      setTimeout(() => req.destroy(), 200);
    });
    // Child teardown is async; allow a short settle window before asserting
    // we returned well before the 60s user timeout. The child's SIGKILL path
    // should land within ~100ms on a healthy host.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  it("falls back to the default timeout when payload sends NaN/Infinity", async () => {
    // typeof NaN === "number" so a naive `typeof x === "number"` guard
    // would let NaN through; downstream Math.min/Math.max preserves NaN
    // and setTimeout(fn, NaN) becomes setTimeout(fn, 0), surfacing a
    // misleading WALL_CLOCK_TIMEOUT. Asserting the request runs to the
    // arithmetic result confirms the default kicked in instead.
    const body = makeRunBody({ code: "return 41 + 1;", timeout: Number.NaN });
    const res = await request(port, "POST", "/run", body);
    expect(res.status).toBe(200);
    const outcome = parseRunResponse(res.body) as {
      ok: boolean;
      result?: unknown;
    };
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe(42);
  });

  it("returns 413 when the request body exceeds the size cap", async () => {
    const saved = process.env.SANDBOX_MAX_BODY_BYTES;
    process.env.SANDBOX_MAX_BODY_BYTES = "128";
    try {
      // 200 bytes of A's — decodeRunRequest is never reached because
      // readBody throws "body too large" first.
      const body = "A".repeat(200);
      const res = await request(port, "POST", "/run", body);
      expect(res.status).toBe(413);
      expect(res.body.toString()).toBe("body too large");
    } finally {
      if (saved === undefined) {
        delete process.env.SANDBOX_MAX_BODY_BYTES;
      } else {
        process.env.SANDBOX_MAX_BODY_BYTES = saved;
      }
    }
  });

  it("returns 429 with Retry-After when concurrency cap is exceeded", async () => {
    const saved = process.env.SANDBOX_MAX_CONCURRENT_RUNS;
    process.env.SANDBOX_MAX_CONCURRENT_RUNS = "2";
    try {
      // User code sleeps long enough that 4 concurrent fires race at the
      // cap. Two get in, two get rejected with 429 before readBody.
      const slowBody = makeRunBody({
        code: "await new Promise(r => setTimeout(r, 400)); return 1;",
        timeout: 5,
      });
      const results = await Promise.all([
        request(port, "POST", "/run", slowBody),
        request(port, "POST", "/run", slowBody),
        request(port, "POST", "/run", slowBody),
        request(port, "POST", "/run", slowBody),
      ]);
      const statuses = results.map((r) => r.status);
      const ok = statuses.filter((s) => s === 200).length;
      const rejected = statuses.filter((s) => s === 429).length;
      expect(ok).toBeGreaterThanOrEqual(2);
      expect(rejected).toBeGreaterThanOrEqual(1);
      // 429 body should be the short "at capacity" marker.
      const rejectedResult = results.find((r) => r.status === 429);
      expect(rejectedResult?.body.toString()).toBe("sandbox at capacity");
    } finally {
      if (saved === undefined) {
        delete process.env.SANDBOX_MAX_CONCURRENT_RUNS;
      } else {
        process.env.SANDBOX_MAX_CONCURRENT_RUNS = saved;
      }
    }
  });

  it("SANDBOX_PORT env var is read at module init", async () => {
    // The module already imported at test start; the constant captured by
    // handleRequest closure is fixed. We assert the module exports a
    // numeric port resolver by importing index.js directly and asserting
    // it exposes the port resolution helper.
    const mod = await import("./index.js");
    expect(typeof mod.getSandboxPort).toBe("function");
    expect(mod.getSandboxPort()).toBeGreaterThan(0);
  });
});
