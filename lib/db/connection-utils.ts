/**
 * Database connection utilities
 *
 * Handles URL encoding of database credentials with special characters.
 * Imports must stay free of `server-only` (transitively) because
 * `drizzle.config.ts` loads this file at CLI time.
 */

/**
 * Protocol prefix for PostgreSQL connection strings
 */
const CONNECTION_STRING_PREFIX = /^(postgres(?:ql)?:\/\/)/;
const SSLMODE_PATTERN = /([?&])sslmode=[^&]*/;

function safeDecodeUriComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Ensures that the database connection string has properly URL-encoded credentials.
 * Uses the last @ as the separator between userinfo and host so that passwords
 * containing @ or : are parsed correctly. Decodes then re-encodes to avoid
 * double-encoding when the URL already contains encoded credentials.
 *
 * @param connectionString - PostgreSQL connection string
 * @returns Connection string with properly encoded credentials
 */
export function ensureEncodedConnectionString(
  connectionString: string
): string {
  const prefixMatch = connectionString.match(CONNECTION_STRING_PREFIX);
  if (!prefixMatch) {
    return connectionString;
  }
  const protocol = prefixMatch[1];
  const rest = connectionString.slice(protocol.length);
  const lastAt = rest.lastIndexOf("@");
  if (lastAt === -1) {
    return connectionString;
  }
  const userinfo = rest.slice(0, lastAt);
  const hostAndDb = rest.slice(lastAt + 1);
  const firstColon = userinfo.indexOf(":");
  const rawUsername =
    firstColon === -1 ? userinfo : userinfo.slice(0, firstColon);
  const rawPassword = firstColon === -1 ? "" : userinfo.slice(firstColon + 1);
  const username = safeDecodeUriComponent(rawUsername);
  const password = safeDecodeUriComponent(rawPassword);
  return `${protocol}${encodeURIComponent(username)}:${encodeURIComponent(password)}@${hostAndDb}`;
}

interface PgQueryError extends Error {
  severity: string;
  code?: string;
  detail?: string;
  hint?: string;
}

const PG_SEVERITIES = new Set([
  "ERROR",
  "FATAL",
  "PANIC",
  "WARNING",
  "NOTICE",
  "DEBUG",
  "INFO",
  "LOG",
]);

function isPgQueryError(error: Error): error is PgQueryError {
  if (!("severity" in error)) {
    return false;
  }
  const severity = (error as { severity: unknown }).severity;
  return typeof severity === "string" && PG_SEVERITIES.has(severity);
}

/** Format a PostgreSQL query error with code, detail and hint context. */
function formatPgQueryError(error: PgQueryError): string {
  let message = error.message;
  if (error.code) {
    message += ` (code: ${error.code})`;
  }
  if (error.detail) {
    message += ` Detail: ${error.detail}`;
  }
  if (error.hint) {
    message += ` Hint: ${error.hint}`;
  }
  return message;
}

/** Max error -> cause levels to inspect (drizzle wraps the driver error). */
const MAX_ERROR_CAUSE_DEPTH = 5;

/**
 * Collect the `code` values and concatenated messages across an error's
 * cause chain. The driver error is often wrapped (drizzle nests it under
 * `cause`), so the connection code/message can live below the top level.
 */
function collectErrorChain(error: Error): { codes: Set<string>; text: string } {
  const codes = new Set<string>();
  const messages: string[] = [];
  let current: unknown = error;
  for (
    let depth = 0;
    depth <= MAX_ERROR_CAUSE_DEPTH && current instanceof Error;
    depth++
  ) {
    messages.push(current.message);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      codes.add(code);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return { codes, text: messages.join(" ") };
}

/**
 * Returns a safe, user-facing message for database errors.
 * Shows query errors from PostgreSQL directly (they don't contain credentials).
 * Sanitizes connection errors to avoid leaking internal details.
 *
 * NOTE: This function is only used for user-provided external database connections
 * (Database Query step and test-connection). Do not use it for KeeperHub's internal
 * database errors, as PG query messages can expose schema/table/column names.
 */
export function getDatabaseErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown database error";
  }

  // PostgreSQL query errors (syntax errors, constraint violations, etc.)
  // are safe to show -- they describe the SQL problem, not credentials.
  // Drizzle ORM wraps PostgresError in error.cause, so check both levels.
  if (isPgQueryError(error)) {
    return formatPgQueryError(error);
  }
  const cause = error.cause;
  if (cause instanceof Error && isPgQueryError(cause)) {
    return formatPgQueryError(cause);
  }

  // Connection-level errors -- sanitize to avoid leaking credentials. Classify
  // against the code + message of the whole cause chain (drizzle wraps the
  // driver error), preferring `code` for socket/connect failures so query text
  // can't trigger a false match. Only canned strings are returned, never raw text.
  const { codes, text } = collectErrorChain(error);

  if (codes.has("ECONNREFUSED") || text.includes("ECONNREFUSED")) {
    return "Connection refused. Please check your database URL and ensure the database is running.";
  }
  if (codes.has("ENOTFOUND") || text.includes("ENOTFOUND")) {
    return "Database host not found. Please check your database URL.";
  }
  if (codes.has("ENETUNREACH") || text.includes("ENETUNREACH")) {
    return "Network unreachable. The database host may resolve to an IPv6 address; try using an IPv4 address or a hostname that resolves to IPv4.";
  }
  if (
    codes.has("CONNECT_TIMEOUT") ||
    codes.has("ETIMEDOUT") ||
    text.includes("CONNECT_TIMEOUT") ||
    text.includes("ETIMEDOUT")
  ) {
    return "Connection timed out. Please check your database host and network settings.";
  }
  if (text.includes("authentication failed")) {
    return "Authentication failed. Please check your database credentials.";
  }
  if (text.includes("does not exist")) {
    return "Database or resource not found. Please verify the database name and user permissions.";
  }
  if (text.includes("SSL") || text.includes("TLS")) {
    return "SSL/TLS connection error. Try a different SSL mode (e.g. Require or Disable).";
  }

  return "Database connection failed. Please verify your connection settings.";
}

export type DatabaseConnectionConfig = {
  url?: string;
  host?: string;
  port?: string;
  username?: string;
  password?: string;
  database?: string;
};

/**
 * Checks whether the given config has enough fields to attempt a database connection.
 * Accepts either a connection URL or the individual host/username/password/database fields.
 */
export function hasValidDatabaseConfig(
  config: Record<string, string | undefined>
): boolean {
  const hasUrl = typeof config.url === "string" && config.url.trim() !== "";
  const hasParts =
    typeof config.host === "string" &&
    config.host.trim() !== "" &&
    typeof config.username === "string" &&
    config.username.trim() !== "" &&
    typeof config.password === "string" &&
    typeof config.database === "string" &&
    config.database.trim() !== "";
  return hasUrl || hasParts;
}

/**
 * Builds a single PostgreSQL connection URL from integration config.
 * Prefers building from separate fields (host, username, password, database) when all are present; otherwise uses config.url.
 *
 * @param config - Integration config with optional url or host/port/username/password/database
 * @returns Connection string or null if config is insufficient
 */
export function buildDatabaseUrlFromConfig(
  config: DatabaseConnectionConfig
): string | null {
  const hasParts =
    typeof config.host === "string" &&
    config.host.trim() !== "" &&
    typeof config.username === "string" &&
    config.username.trim() !== "" &&
    typeof config.password === "string" &&
    typeof config.database === "string" &&
    config.database.trim() !== "";

  if (hasParts) {
    const host = config.host?.trim() ?? "";
    const port = config.port?.trim() || "5432";
    const username = config.username?.trim() ?? "";
    const password = config.password ?? "";
    const database = config.database?.trim() ?? "";
    const encoded = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
    return `postgresql://${encoded}@${host}:${port}/${database}`;
  }

  if (typeof config.url === "string" && config.url.trim() !== "") {
    return ensureEncodedConnectionString(config.url.trim());
  }

  return null;
}

/**
 * Gets the database connection string from environment with proper encoding.
 * Production should set DATABASE_URL; fallback is for development only.
 *
 * @param fallback - Optional fallback when DATABASE_URL is not set (e.g. dev)
 * @returns Properly encoded connection string
 */
export function getDatabaseUrl(fallback?: string): string {
  const connectionString =
    (process.env.DATABASE_URL || fallback) ??
    "postgres://localhost:5432/workflow";
  return ensureEncodedConnectionString(connectionString);
}

/**
 * Ensures the connection URL has an explicit sslmode to suppress
 * pg-connection-string deprecation warnings. In pg v9.0.0, 'require',
 * 'prefer', and 'verify-ca' will adopt weaker libpq semantics.
 * This replaces those deprecated aliases with 'verify-full' for remote
 * hosts, preserving the current (stronger) behavior.
 *
 * Uses string manipulation to avoid re-encoding credentials via URL.toString().
 */
export function ensureExplicitSslMode(url: string): string {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const isLocal =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "" ||
      hostname.endsWith(".svc.cluster.local");
    if (isLocal) {
      return url;
    }

    const currentMode = parsed.searchParams.get("sslmode");
    if (currentMode === "verify-full" || currentMode === "disable") {
      return url;
    }
  } catch {
    return url;
  }

  if (SSLMODE_PATTERN.test(url)) {
    return url.replace(SSLMODE_PATTERN, "$1sslmode=verify-full");
  }
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}sslmode=verify-full`;
}

export type PostgresSslOption =
  | "require"
  | "prefer"
  | "allow"
  | "verify-full"
  | false;

function sslModeToOption(mode: string): PostgresSslOption {
  const m = mode.toLowerCase();
  if (m === "disable" || m === "false") {
    return false;
  }
  if (m === "require") {
    return "require";
  }
  if (m === "prefer") {
    return "prefer";
  }
  if (m === "allow") {
    return "allow";
  }
  if (m === "verify-full") {
    return "verify-full";
  }
  return false;
}

/**
 * Returns normalized connection URL and ssl option for postgres.js client.
 * Use for Database Query step and test connection API.
 *
 * @param url - Raw PostgreSQL connection string (postgres:// or postgresql://)
 * @param sslMode - User choice: 'require' | 'prefer' | 'allow' | 'verify-full' | 'disable' | 'auto' (default). When 'auto', uses URL sslmode/ssl if present, else SSL for remote hosts.
 */
export function getPostgresConnectionOptions(
  url: string,
  sslMode?: string
): { normalizedUrl: string; ssl: PostgresSslOption } {
  const normalizedUrl = ensureEncodedConnectionString(url);

  if (
    sslMode === "require" ||
    sslMode === "prefer" ||
    sslMode === "allow" ||
    sslMode === "verify-full"
  ) {
    return { normalizedUrl, ssl: sslModeToOption(sslMode) };
  }
  if (sslMode === "disable") {
    return { normalizedUrl, ssl: false };
  }

  // 'auto' or missing: respect sslmode/ssl from URL if present
  try {
    const parsed = new URL(normalizedUrl);
    const urlSsl =
      parsed.searchParams.get("sslmode") ?? parsed.searchParams.get("ssl");
    if (urlSsl !== null && urlSsl !== "") {
      return { normalizedUrl, ssl: sslModeToOption(urlSsl) };
    }
  } catch {
    // fall through to hostname heuristic
  }

  // No URL ssl param: enable SSL for remote hosts (production); disable for local/dev hostnames
  let hostname: string;
  try {
    const parsed = new URL(normalizedUrl);
    hostname = parsed.hostname ?? "";
  } catch {
    hostname = "";
  }
  const isLocalDev =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "";
  return {
    normalizedUrl,
    ssl: isLocalDev ? false : "require",
  };
}
