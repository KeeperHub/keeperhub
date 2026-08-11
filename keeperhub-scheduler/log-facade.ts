/**
 * Vendored console facade for the keeperhub-scheduler satellite.
 *
 * Normalizes all console.* output in this process to canonical single-line
 * JSON ({ level, ts, msg, err? }) matching the KeeperHub app's logging contract
 * (lib/log/core.ts), so Grafana Loki `| json` works uniformly across the app
 * and every satellite service. Import this module FIRST at the service
 * entrypoint, before any module that logs.
 *
 * Self-contained by design: satellites are separate packages and cannot import
 * the app's `@/lib/*`. Keep in sync with the app's lib/log/core.ts +
 * lib/logger.ts.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function threshold(): number {
  const level = (process.env.LOG_LEVEL || "info").toLowerCase();
  return level in LEVELS ? LEVELS[level] : LEVELS.info;
}

function describe(arg: unknown): string {
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

function emit(
  level: LogLevel,
  write: (line: string) => void,
  args: unknown[],
): void {
  if (LEVELS[level] < threshold()) {
    return;
  }
  const payload: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    msg: args.map(describe).join(" "),
  };
  const error = args.find((a): a is Error => a instanceof Error);
  if (error) {
    payload.err = {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  write(JSON.stringify(payload));
}

console.debug = (...args: unknown[]) => emit("debug", original.debug, args);
console.log = (...args: unknown[]) => emit("info", original.log, args);
console.info = (...args: unknown[]) => emit("info", original.info, args);
console.warn = (...args: unknown[]) => emit("warn", original.warn, args);
console.error = (...args: unknown[]) => emit("error", original.error, args);

export {};
