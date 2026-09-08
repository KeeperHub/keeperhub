import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  encodeSandboxResult,
  SANDBOX_WIRE_VERSION,
} from "../../lib/sandbox/child-source.js";
import { runCode, type SandboxRunResult } from "./run-code.js";

/**
 * Sentinel bytes byte-identical to the child_process runner. Main-app
 * client locates the serialized ChildOutcome by `lastIndexOf(sentinel)`
 * so stray user-code stdout writes cannot mask the real result.
 */
const RESULT_SENTINEL = "\u0001RESULT\u0002";

/** Default maximum request body size (512 KiB). The body is JSON
 * `{ code, timeout }`, and JSON.stringify can inflate escape-heavy user code
 * up to ~2x (every quote/backslash/control char escapes) -- versus the old
 * base64(v8) wire's flat ~1.33x. The cap is raised so a large escape-heavy
 * Code node that fit the old wire is not rejected with a 413. It is a DoS
 * backstop, not a product limit; readBody enforces it before any spawn.
 * Env-overridable. */
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;

/** Default maximum concurrent /run calls per Pod. With 500m CPU + ~80 ms
 * cold-spawn + V8 compile of CHILD_SOURCE, the Pod saturates around 8
 * parallel runs; more than that queues on the OS scheduler and degrades
 * tail latency for everyone. Env-overridable. */
const DEFAULT_MAX_CONCURRENT_RUNS = 8;

/** Default timeout when the payload omits one — matches main-app default. */
const DEFAULT_TIMEOUT_SECONDS = 60;

type RunRequest = {
  code: unknown;
  timeout?: unknown;
};

const SANDBOX_PORT = Number.parseInt(process.env.SANDBOX_PORT ?? "8787", 10);

/** Read once at module init; exported for tests to verify the env wiring. */
export function getSandboxPort(): number {
  return SANDBOX_PORT;
}

/**
 * Per-request env lookup. Kept dynamic so tests (and operational knobs)
 * can adjust caps without a process restart; per-request Number.parseInt
 * is negligible versus the spawn cost it gates.
 */
function getMaxBodyBytes(): number {
  const raw = process.env.SANDBOX_MAX_BODY_BYTES;
  if (raw === undefined) {
    return DEFAULT_MAX_BODY_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_BODY_BYTES;
}

function getMaxConcurrentRuns(): number {
  const raw = process.env.SANDBOX_MAX_CONCURRENT_RUNS;
  if (raw === undefined) {
    return DEFAULT_MAX_CONCURRENT_RUNS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_CONCURRENT_RUNS;
}

/** Global in-flight /run counter. Single-event-loop mutation is race-free
 * because check-and-increment happens without an intervening await. */
let inFlightRuns = 0;

async function readBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new Error("body too large");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function writeRunResult(res: ServerResponse, result: SandboxRunResult): void {
  // A relayed frame is the child's tagged-JSON forwarded verbatim; only a
  // synthetic error outcome needs encoding here.
  const payload = result.relay
    ? result.frame.toString("utf8")
    : encodeSandboxResult(result.outcome);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "X-KH-Sandbox-Wire": SANDBOX_WIRE_VERSION,
  });
  res.end(`${RESULT_SENTINEL}${payload}\n`);
}

function decodeRunRequest(raw: Buffer): RunRequest | null {
  try {
    const deserialized: unknown = JSON.parse(raw.toString("utf8"));
    if (
      typeof deserialized !== "object" ||
      deserialized === null ||
      !("code" in deserialized)
    ) {
      return null;
    }
    return deserialized as RunRequest;
  } catch {
    return null;
  }
}

async function handlePostRun(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // Reject a wire-version skew up front with a clear 415 (e.g. an older app
  // that still speaks base64(v8)) instead of a confusing "malformed body".
  const wire = req.headers["x-kh-sandbox-wire"];
  if (wire !== SANDBOX_WIRE_VERSION) {
    res.writeHead(415);
    res.end(
      `unsupported sandbox wire version: ${typeof wire === "string" ? wire : "none"}; expected ${SANDBOX_WIRE_VERSION}`
    );
    return;
  }

  // Concurrency gate BEFORE anything else so we shed load without paying
  // the cost of reading the body or spawning a child. 429 + Retry-After
  // tells the main-app client to back off; the kept-alive HTTP.Agent there
  // will reuse the socket for the retry, so this is cheap.
  if (inFlightRuns >= getMaxConcurrentRuns()) {
    res.setHeader("Retry-After", "1");
    res.writeHead(429);
    res.end("sandbox at capacity");
    return;
  }

  // If the client disconnects before we finish writing the response, we
  // cancel the child so sandbox capacity is not pinned beyond the caller's
  // view. Without this, a slow user script keeps running after the main-app
  // request timed out and gave up on the socket.
  //
  // Listen on `res`, not `req`: IncomingMessage's 'close' fires at end of
  // body-stream consumption (often well before the response is sent), while
  // ServerResponse's 'close' fires when the underlying connection is torn
  // down either by our res.end() or by a client disconnect. The guard
  // `!res.writableEnded` means "we hadn't finished writing yet" — that's
  // the true client-abort condition.
  const abortController = new AbortController();
  const onResClose = (): void => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  };
  res.on("close", onResClose);

  try {
    inFlightRuns++;
    const raw = await readBody(req, getMaxBodyBytes());
    if (raw.length === 0) {
      res.writeHead(400);
      res.end("empty body");
      return;
    }
    const request = decodeRunRequest(raw);
    if (request === null || typeof request.code !== "string") {
      res.writeHead(400);
      res.end("malformed body");
      return;
    }
    // typeof NaN === "number" is true; Number.isFinite weeds out NaN
    // and ±Infinity which would otherwise propagate into setTimeout as 0
    // and surface a misleading WALL_CLOCK_TIMEOUT instead of a clear
    // "bad input" rejection.
    const timeoutSeconds =
      typeof request.timeout === "number" && Number.isFinite(request.timeout)
        ? request.timeout
        : DEFAULT_TIMEOUT_SECONDS;
    const timeoutMs = Math.max(1, Math.min(120, timeoutSeconds)) * 1000;
    const result = await runCode({
      code: request.code,
      timeoutMs,
      signal: abortController.signal,
    });
    // Client already gone; writing would throw ERR_STREAM_DESTROYED. The
    // abort wired above has already killed the child, so we just return.
    if (res.writableEnded || res.destroyed) {
      return;
    }
    writeRunResult(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "body too large") {
      if (!(res.headersSent || res.destroyed)) {
        res.writeHead(413);
        res.end("body too large");
      }
      return;
    }
    // biome-ignore lint/suspicious/noConsole: sandbox runtime emits stderr for fatal paths so platform logs surface them
    console.error(`[Sandbox] /run failed: ${message}`);
    if (!(res.headersSent || res.destroyed)) {
      res.writeHead(500);
      res.end("sandbox internal error");
    }
  } finally {
    inFlightRuns--;
    res.off("close", onResClose);
  }
}

/**
 * Main HTTP request dispatcher. Separated from server creation so tests
 * can mount their own server on an ephemeral port.
 */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = (req.url ?? "").split("?")[0];

  if (req.method === "GET" && url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "POST" && url === "/run") {
    handlePostRun(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
}

async function main(): Promise<void> {
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      handleRequest(req, res);
    }
  );

  process.on("uncaughtException", (err: Error) => {
    // biome-ignore lint/suspicious/noConsole: fatal path; must surface to pod stderr before exit
    console.error(
      `[Fatal] uncaughtException: ${err.message}\n${err.stack ?? ""}`
    );
    process.exit(1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    // biome-ignore lint/suspicious/noConsole: fatal path; must surface to pod stderr before exit
    console.error(`[Fatal] unhandledRejection: ${message}`);
    process.exit(1);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[Shutdown] received ${signal}`);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SANDBOX_PORT, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(`[Sandbox] listening on :${SANDBOX_PORT}`);
}

// Only auto-start when executed directly, not when imported by tests.
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.env.SANDBOX_AUTOSTART === "1"
) {
  main();
}
