/**
 * Event-tracker structured logger.
 *
 * Emits canonical single-line JSON ({ level, ts, msg, ... }) matching the
 * KeeperHub app's logging contract (lib/log/core.ts) so Grafana Loki can query
 * across the app and all satellite services uniformly via `| json`. Previously
 * this emitted multi-line pretty-printed JSON (`log :: <ts> - {...}`), which
 * broke line-based aggregation. Kept dependency-free: this is a separate
 * package and cannot import the app's `@/lib/*`.
 */

type LogLevel = "info" | "warn" | "error";

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export class Logger {
  private logger: Console;

  constructor(loggerInstance: Console) {
    this.logger = loggerInstance;
  }

  private emit(level: LogLevel, message: unknown): void {
    const msg = typeof message === "string" ? message : safeStringify(message);
    const line = JSON.stringify({
      level,
      ts: new Date().toISOString(),
      msg,
    });
    if (level === "error") {
      this.logger.error(line);
    } else if (level === "warn") {
      this.logger.warn(line);
    } else {
      this.logger.log(line);
    }
  }

  log(message: unknown): void {
    this.emit("info", message);
  }

  error(message: unknown): void {
    this.emit("error", message);
  }

  warn(message: unknown): void {
    this.emit("warn", message);
  }

  stringify(data: unknown): string {
    return safeStringify(data);
  }

  formatAddress(address: string): string {
    if (!address || address.length < 10) {
      return address;
    }
    const cleanAddress = address.startsWith("0x") ? address.slice(2) : address;
    return `${cleanAddress.slice(0, 5)}...${cleanAddress.slice(-5)}`;
  }
}

export const logger = new Logger(console);
