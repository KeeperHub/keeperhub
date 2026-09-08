import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";

import { spawn } from "node:child_process";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  SANDBOX_CHILD_SOURCE as CHILD_SOURCE,
  SANDBOX_RESULT_FD,
  type SandboxResultReader,
  createSandboxResultReader,
  decodeSandboxResult,
} from "@/lib/sandbox/child-source";
import {
  type ChildOutcome,
  extractLineNumber,
  isChildOutcome,
  type RunCodeResult,
  runRemote,
} from "@/lib/sandbox/client";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";

export type RunCodeCoreInput = {
  code: string;
  timeout?: number;
};

export type RunCodeInput = StepInput & RunCodeCoreInput;

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 120;
const UNRESOLVED_TEMPLATE_REGEX = /\{\{@?[^}]+\}\}/g;

const SANDBOX_BACKEND = process.env.SANDBOX_BACKEND;

if (
  process.env.NODE_ENV === "production" &&
  (SANDBOX_BACKEND !== "remote" || !process.env.SANDBOX_URL)
) {
  throw new Error(
    "SANDBOX_BACKEND must be 'remote' and SANDBOX_URL must be set in production"
  );
}

// Remove string/template-literal bodies and `//` + block comments so the
// template scan only sees executable code. Refs inside strings or comments are
// data or documentation, not dependencies, and must not be flagged as
// unresolved -- the executor deliberately leaves them in place. Mirrors the
// string/comment-aware scanning in executor.workflow.ts.
function stripStringsAndComments(code: string): string {
  const out: string[] = [];
  const n = code.length;
  let i = 0;
  let stringDelim: string | null = null;
  while (i < n) {
    const c = code[i];
    if (stringDelim) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === stringDelim) {
        stringDelim = null;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      stringDelim = c;
      i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      i += 2;
      while (i < n && code[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        i++;
      }
      i = Math.min(i + 2, n);
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

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

function outcomeFromReader(reader: SandboxResultReader): ChildOutcome {
  if (reader.error) {
    return { ok: false, errorMessage: reader.error, logs: [] };
  }
  if (!reader.frame) {
    return { ok: false, errorMessage: "Sandbox produced no result", logs: [] };
  }
  try {
    // Safe by construction: JSON.parse + tag rebuild, never v8.deserialize on
    // child-produced bytes (F-010). This parent is the privileged in-pod app,
    // so the no-untrusted-deserialize property matters most here. Validate the
    // envelope shape since the child is untrusted.
    const decoded = decodeSandboxResult(reader.frame.toString("utf8"));
    if (!isChildOutcome(decoded)) {
      return {
        ok: false,
        errorMessage: "Sandbox produced malformed result",
        logs: [],
      };
    }
    return decoded;
  } catch (_err) {
    return {
      ok: false,
      errorMessage: "Sandbox produced malformed result",
      logs: [],
    };
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: single cohesive spawner with timeout + stream aggregation + graceful teardown + signal wiring
async function runInChild(
  code: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ChildOutcome> {
  return await new Promise<ChildOutcome>((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, errorMessage: "ABORTED", logs: [] });
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

    function finish(outcome: ChildOutcome): void {
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
      resolve(outcome);
    }

    const killTimer = setTimeout(() => {
      finish({ ok: false, errorMessage: "WALL_CLOCK_TIMEOUT", logs: [] });
    }, timeoutMs + 1000);

    const onAbort = (): void => {
      finish({ ok: false, errorMessage: "ABORTED", logs: [] });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

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
          finish(outcomeFromReader(resultReader));
        }
      });
      resultStream.on("error", () => {
        // Pipe teardown races process exit; the close handler maps the outcome.
      });
    }

    child.on("error", (err: Error) => {
      finish({
        ok: false,
        errorMessage: err.message || String(err),
        errorStack: err.stack,
        logs: [],
      });
    });

    child.on("close", (exitCode: number | null) => {
      const parsed = outcomeFromReader(resultReader);
      if (parsed.ok || exitCode === 0) {
        finish(parsed);
        return;
      }
      finish({
        ok: false,
        errorMessage:
          parsed.errorMessage !== "Sandbox produced no result"
            ? parsed.errorMessage
            : `Sandbox process exited with code ${String(exitCode)}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
        logs: [],
      });
    });

    try {
      child.stdin.write(JSON.stringify({ code, timeoutMs }));
      child.stdin.end();
    } catch (err) {
      finish({
        ok: false,
        errorMessage: `Failed to send code to sandbox: ${err instanceof Error ? err.message : String(err)}`,
        logs: [],
      });
    }
  });
}

/**
 * Pre-flight input validation shared by both backends. Returns a failure
 * RunCodeResult if the input is unrunnable, otherwise null — callers branch
 * on the return value.
 */
function validateInput(input: RunCodeCoreInput): RunCodeResult | null {
  const { code } = input;
  if (!code || code.trim() === "") {
    return { success: false, error: "No code provided", logs: [], errorClass: ExecutionErrorType.USER };
  }
  const unresolvedTemplates = stripStringsAndComments(code).match(
    UNRESOLVED_TEMPLATE_REGEX,
  );
  if (unresolvedTemplates) {
    const unique = [...new Set(unresolvedTemplates)];
    return {
      success: false,
      error: `Unresolved template variables: ${unique.join(", ")}. Make sure upstream nodes have executed and their outputs are available.`,
      logs: [],
      errorClass: ExecutionErrorType.USER,
    };
  }
  return null;
}

/**
 * In-pod child_process runner preserved verbatim from PR #953. When
 * SANDBOX_BACKEND is "local" (default) or unset, the main app evaluates user
 * code via this runner — a spawned Node process with a scrubbed env and
 * node:vm.runInContext inside a single-use context.
 */
async function runLocal(
  input: RunCodeCoreInput,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<RunCodeResult> {
  const timeoutMs = timeoutSeconds * 1000;
  const outcome = await runInChild(input.code, timeoutMs, signal);

  if (outcome.ok) {
    return { success: true, result: outcome.result, logs: outcome.logs };
  }

  const isTimeout =
    outcome.errorMessage.includes("Script execution timed out") ||
    outcome.errorMessage === "WALL_CLOCK_TIMEOUT";

  const errorMessage = isTimeout
    ? `Code execution timed out after ${String(timeoutSeconds)} second${timeoutSeconds === 1 ? "" : "s"}`
    : `Code execution failed: ${outcome.errorMessage}`;

  logUserError(
    ErrorCategory.VALIDATION,
    "[Code] Execution error:",
    new Error(outcome.errorMessage),
    {
      plugin_name: "code",
      action_name: "run-code",
    },
  );

  const line = extractLineNumber(outcome.errorStack);

  return {
    success: false,
    error: errorMessage,
    logs: outcome.logs,
    errorClass: ExecutionErrorType.USER,
    ...(line !== undefined ? { line } : {}),
  };
}

/**
 * Normalize a runRemote() RunCodeResult to match the error-message shape
 * runLocal emits. The sandbox-client translator ferries ChildOutcome
 * error text through unchanged; the main-app contract wants "Code
 * execution failed: ..." for general errors and "Code execution timed
 * out after N second(s)" for timeouts so downstream consumers (UI,
 * alerting) see identical copy across backends.
 */
function normalizeRemoteError(
  outcome: RunCodeResult,
  timeoutSeconds: number,
): RunCodeResult {
  if (outcome.success) {
    return outcome;
  }
  const raw = outcome.error;
  const isTimeout =
    raw.includes("Script execution timed out") ||
    raw === "WALL_CLOCK_TIMEOUT" ||
    raw.includes("timed out after");
  const rewritten = isTimeout
    ? `Code execution timed out after ${String(timeoutSeconds)} second${timeoutSeconds === 1 ? "" : "s"}`
    : raw.startsWith("Code execution failed:") ||
        raw.startsWith("sandbox client error:") ||
        raw.startsWith("No code provided") ||
        raw.startsWith("Unresolved template variables:")
      ? raw
      : `Code execution failed: ${raw}`;
  return { ...outcome, error: rewritten };
}

async function stepHandler(input: RunCodeCoreInput): Promise<RunCodeResult> {
  const validationError = validateInput(input);
  if (validationError) {
    return validationError;
  }
  const rawTimeout = input.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const clampedSeconds = Math.min(
    Math.max(1, rawTimeout),
    MAX_TIMEOUT_SECONDS,
  );
  if (SANDBOX_BACKEND === "remote") {
    const outcome = await runRemote({
      code: input.code,
      timeoutMs: clampedSeconds * 1000,
    });
    return normalizeRemoteError(outcome, clampedSeconds);
  }
  return runLocal(input, clampedSeconds);
}

// biome-ignore lint/suspicious/useAwait: "use step" directive requires async
export async function runCodeStep(input: RunCodeInput): Promise<RunCodeResult> {
  "use step";

  return runPluginStep(
    { pluginName: "code", actionName: "run-code" },
    input,
    stepHandler,
  );
}
runCodeStep.maxRetries = 0;

export const _integrationType = "code";
