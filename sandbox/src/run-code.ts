import { spawn } from "node:child_process";
import {
  SANDBOX_CHILD_SOURCE as CHILD_SOURCE,
  createSandboxResultReader,
  SANDBOX_RESULT_FD,
  type SandboxResultReader,
} from "../../lib/sandbox/child-source.js";

type LogEntry = {
  level: "log" | "warn" | "error";
  args: unknown[];
};

export type ChildOutcome =
  | { ok: true; result: unknown; logs: LogEntry[] }
  | {
      ok: false;
      errorMessage: string;
      errorStack?: string;
      logs: LogEntry[];
    };

/**
 * Environment variables forwarded to the sandbox child process. Everything
 * else is dropped so that a sandbox escape cannot read pod secrets from
 * process.env nor from /proc/self/environ (the child is a fresh OS process
 * started with execve, so its kernel-level environ is exactly this set).
 * Keep minimal: only what Node itself needs to start and make TLS calls.
 * Do NOT add application secrets here.
 */
const CHILD_ENV_ALLOWLIST = [
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "TZ",
  "LANG",
  "LC_ALL",
] as const;

function buildChildEnv(): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as NodeJS.ProcessEnv;
}

function isLogEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const e = value as { level?: unknown; args?: unknown };
  return typeof e.level === "string" && Array.isArray(e.args);
}

/**
 * Exported for unit testing. A SHALLOW envelope check on the UN-REVIVED frame:
 * the server only relays the frame to the main-app client, which revives it and
 * strictly validates (e.g. errorStack type). The child is untrusted (a vm
 * escape can forge a frame), so we confirm a plausible ChildOutcome envelope --
 * the `ok` discriminant, well-shaped logs, and a string errorMessage on
 * ok:false -- without inspecting tagged values like a `{ "$": "undef" }`
 * errorStack, which only resolves after the client revives the frame.
 */
export function isRelayableEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as { ok?: unknown; logs?: unknown; errorMessage?: unknown };
  if (typeof v.ok !== "boolean" || !Array.isArray(v.logs)) {
    return false;
  }
  if (!v.logs.every(isLogEntry)) {
    return false;
  }
  return v.ok === true || typeof v.errorMessage === "string";
}

/** The ok:false arm of ChildOutcome; every synthetic (non-relay) result is an
 * error, so it always carries errorMessage. */
type ChildErrorOutcome = Extract<ChildOutcome, { ok: false }>;

/**
 * A run result the server writes to the HTTP response. A valid child frame is
 * RELAYED verbatim -- it is already the tagged-JSON the main-app client reads,
 * so the server does not revive tagged values nor re-encode them. Synthetic
 * errors (timeout, abort, malformed/no frame) carry an error outcome to encode.
 */
export type SandboxRunResult =
  | { relay: true; frame: Buffer }
  | { relay: false; outcome: ChildErrorOutcome };

function syntheticError(errorMessage: string): SandboxRunResult {
  return { relay: false, outcome: { ok: false, errorMessage, logs: [] } };
}

function resultFromReader(reader: SandboxResultReader): SandboxRunResult {
  if (reader.error) {
    return syntheticError(reader.error);
  }
  if (!reader.frame) {
    return syntheticError("Sandbox produced no result");
  }
  // Validate the envelope WITHOUT reviving tagged values: the server only
  // relays the frame to the main-app client, which revives it and strictly
  // validates. A shallow JSON.parse + envelope check is enough here; the frame
  // is then forwarded verbatim, avoiding a decode + re-encode (and the
  // BigInt/Map/Buffer allocations + double base64) per request.
  try {
    const parsed: unknown = JSON.parse(reader.frame.toString("utf8"));
    if (!isRelayableEnvelope(parsed)) {
      return syntheticError("Sandbox produced malformed result");
    }
    return { relay: true, frame: reader.frame };
  } catch {
    return syntheticError("Sandbox produced malformed result");
  }
}

/**
 * Spawn a child Node process with a scrubbed env, run the user code inside
 * it, and return the child's result. Kills the child on timeout or when
 * the caller's AbortSignal fires.
 */
async function runInChild(
  code: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SandboxRunResult> {
  return await new Promise<SandboxRunResult>((resolve) => {
    if (signal?.aborted) {
      resolve(syntheticError("ABORTED"));
      return;
    }

    // fd 3 is the dedicated result channel (F-010). stdout/stderr stay
    // user-facing diagnostics and are never deserialized.
    const child = spawn(process.execPath, ["-e", CHILD_SOURCE], {
      env: buildChildEnv(),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });

    const resultReader = createSandboxResultReader();
    let stderr = "";
    let settled = false;

    const onAbort = (): void => {
      finish(syntheticError("ABORTED"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(result: SandboxRunResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (!child.killed) {
        try {
          child.kill("SIGKILL");
        } catch (_err) {
          // ignore; child may already have exited
        }
      }
      resolve(result);
    }

    const killTimer = setTimeout(() => {
      finish(syntheticError("WALL_CLOCK_TIMEOUT"));
    }, timeoutMs + 1000);

    // Drain stdout so a sandbox escape that writes there cannot fill the pipe
    // and block the child; the bytes are intentionally discarded (never a
    // result source).
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const resultStream = child.stdio[SANDBOX_RESULT_FD];
    if (resultStream && "on" in resultStream) {
      resultStream.on("data", (chunk: Buffer) => {
        resultReader.push(chunk);
        if (resultReader.done) {
          // First complete frame wins; resolve now and reap the child even if
          // escaped code kept the event loop alive past the result.
          finish(resultFromReader(resultReader));
        }
      });
      resultStream.on("error", () => {
        // Pipe teardown races process exit; the close handler maps the result.
      });
    }

    child.on("error", (err: Error) => {
      finish({
        relay: false,
        outcome: {
          ok: false,
          errorMessage: err.message || String(err),
          errorStack: err.stack,
          logs: [],
        },
      });
    });

    child.on("close", (exitCode: number | null) => {
      const result = resultFromReader(resultReader);
      // A valid frame is relayed as-is; so is anything on a clean exit. Only a
      // synthetic "no result" on a non-zero exit gets the stderr/exit hint.
      if (result.relay || exitCode === 0) {
        finish(result);
        return;
      }
      const noResult =
        result.outcome.errorMessage === "Sandbox produced no result";
      finish({
        relay: false,
        outcome: {
          ok: false,
          errorMessage: noResult
            ? `Sandbox process exited with code ${String(exitCode)}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`
            : result.outcome.errorMessage,
          logs: [],
        },
      });
    });

    try {
      child.stdin.write(JSON.stringify({ code, timeoutMs }));
      child.stdin.end();
    } catch (err) {
      finish(
        syntheticError(
          `Failed to send code to sandbox: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
  });
}

/**
 * Public API: run `code` in a fresh scrubbed child process with a wall-clock
 * timeout of `timeoutMs` milliseconds. Resolves with a SandboxRunResult: either
 * a relayable tagged-JSON frame (the user result, forwarded verbatim) or a
 * synthetic ChildOutcome describing a structured error.
 */
export function runCode(input: {
  code: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<SandboxRunResult> {
  return runInChild(input.code, input.timeoutMs, input.signal);
}
