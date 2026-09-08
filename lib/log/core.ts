/**
 * Canonical structured-log writer.
 *
 * Single source of truth for the JSON log-line schema. Every authoritative
 * emitter (the global console facade in `lib/logger.ts`, the structured error
 * helpers in `lib/logging.ts`, `lib/mcp/logging.ts`) routes through
 * `emitLogLine` so that ALL stdout is single-line JSON of one shape and
 * Grafana Loki `| json` works uniformly.
 *
 * Canonical schema (keys added here: `level`, `ts`):
 *   { "level": "info", "ts": "<ISO-8601>", "msg": "...", ...payload }
 *
 * Output goes through the ORIGINAL console methods captured at module load,
 * so lines are never re-wrapped by the `lib/logger.ts` facade (which would
 * otherwise double-encode JSON inside JSON). Because the facade imports this
 * module, ES module evaluation guarantees this body runs - capturing the
 * pristine console - before the facade patches the globals.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: Record<LogLevel | "silent", number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/**
 * The original console methods, bound before any patching. Authoritative
 * emitters that maintain their own JSON schema (e.g. the metrics console
 * collector) write through these to bypass the facade's normalization.
 */
export const rawConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
} as const;

export function getLogLevel(): LogLevel | "silent" {
  const level = (process.env.LOG_LEVEL || "info").toLowerCase();
  return level in LOG_LEVELS ? (level as LogLevel | "silent") : "info";
}

export function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[getLogLevel()];
}

export type LogPayload = Record<string, unknown> & { msg: string };

/**
 * Emit one canonical JSON log line. Prepends `level` and `ts`; respects
 * `LOG_LEVEL`. No-op when the level is below the configured threshold.
 *
 * The writer is selected from `rawConsole` by level name at call time
 * (error/warn -> stderr, info/debug -> stdout), preserving stream semantics
 * for any consumer reading the stream rather than the JSON `level` field.
 */
export function emitLogLine(level: LogLevel, payload: LogPayload): void {
  if (!shouldLog(level)) {
    return;
  }
  rawConsole[level](
    JSON.stringify({
      level,
      ts: new Date().toISOString(),
      ...payload,
    })
  );
}
