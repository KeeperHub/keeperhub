/**
 * Global console facade with LOG_LEVEL support.
 *
 * Patches console.* so any stray (non-structured) console call is normalized
 * into the canonical single-line JSON schema (`lib/log/core.ts`) instead of a
 * freeform prefixed string. Every server stdout line is therefore valid JSON
 * and Grafana Loki `| json` works uniformly.
 *
 * Authoritative structured emitters (`lib/logging.ts`, `lib/mcp/logging.ts`,
 * the metrics console collector) call into `lib/log/core` directly and are
 * unaffected by this patch.
 *
 * Import this file once at app startup (instrumentation.ts) to patch console
 * globally. All existing console.log/warn/error calls then emit structured
 * JSON that respects LOG_LEVEL.
 *
 * LOG_LEVEL can be: "debug" | "info" | "warn" | "error" | "silent"
 *   - staging:    LOG_LEVEL=debug to see all logs (adds a `caller` field)
 *   - production: LOG_LEVEL=info (default)
 */

import {
  emitLogLine,
  getLogLevel,
  type LogPayload,
  shouldLog,
} from "@/lib/log/core";

// Regex patterns for stack trace parsing (top-level for performance)
const STACK_PATTERN_PARENS = /\((.+):(\d+):\d+\)$/;
const STACK_PATTERN_AT = /at (.+):(\d+):\d+$/;
const PATH_STRIP_PATTERN = /^.*\//;

function getCallerLocation(): string {
  const err = new Error("stack");
  const stack = err.stack?.split("\n") || [];
  // Stack: Error -> getCallerLocation -> console.X wrapper -> actual caller.
  // We want index 3 (the actual caller).
  const callerLine = stack[3] || "";

  const match =
    callerLine.match(STACK_PATTERN_PARENS) ||
    callerLine.match(STACK_PATTERN_AT);

  if (match) {
    const file = match[1].replace(PATH_STRIP_PATTERN, ""); // Get just filename
    return `${file}:${match[2]}`;
  }
  return "";
}

function describeArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}`;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Turn console varargs into a canonical payload. The args are joined into a
 * human-readable `msg`; the first Error (if any) is attached as a structured
 * `err` field so stray error logs remain queryable. The source `caller` is
 * added only at debug level (cost of constructing a stack trace).
 */
function buildPayload(args: unknown[]): LogPayload {
  const payload: LogPayload = { msg: args.map(describeArg).join(" ") };

  const error = args.find((a): a is Error => a instanceof Error);
  if (error) {
    payload.err = {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  if (getLogLevel() === "debug") {
    const caller = getCallerLocation();
    if (caller) {
      payload.caller = caller;
    }
  }

  return payload;
}

// Patch console methods. console.log is treated as info level (matching the
// previous behaviour where it was gated at the info threshold). Level gating
// is short-circuited here to avoid building payloads for dropped lines.
console.debug = (...args: unknown[]) => {
  if (shouldLog("debug")) {
    emitLogLine("debug", buildPayload(args));
  }
};

console.log = (...args: unknown[]) => {
  if (shouldLog("info")) {
    emitLogLine("info", buildPayload(args));
  }
};

console.info = (...args: unknown[]) => {
  if (shouldLog("info")) {
    emitLogLine("info", buildPayload(args));
  }
};

console.warn = (...args: unknown[]) => {
  if (shouldLog("warn")) {
    emitLogLine("warn", buildPayload(args));
  }
};

console.error = (...args: unknown[]) => {
  if (shouldLog("error")) {
    emitLogLine("error", buildPayload(args));
  }
};

// Announce the patch (debug level only).
if (shouldLog("debug")) {
  emitLogLine("debug", {
    msg: `[Logger] Console patched with LOG_LEVEL=${getLogLevel()}`,
  });
}
