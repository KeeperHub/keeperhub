/**
 * Executable step function for Database Query action
 *
 * SECURITY PATTERN - External Secret Store:
 * Step fetches credentials using workflow ID reference
 */
import "server-only";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { assertConnectionUrlIsPublic } from "@/lib/db/connection-host-guard";
import {
  getDatabaseErrorMessage,
  getPostgresConnectionOptions,
  type PostgresSslOption,
} from "@/lib/db/connection-utils";
import { ErrorCategory, logUserError } from "@/lib/logging";
import { sleep } from "@/lib/sleep";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";

type DatabaseQueryResult =
  | { success: true; rows: unknown; count: number }
  | { success: false; error: string };

/** Primitive types accepted by postgres.js, plus objects/arrays that get JSON-stringified */
export type SqlParam =
  | null
  | undefined
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | Record<string, unknown>
  | readonly SqlParam[];

export type DatabaseQueryInput = StepInput & {
  integrationId?: string;
  dbQuery?: string;
  query?: string;
  _dbParams?: SqlParam[];
  // Connection timeout in seconds (default 30, clamped 1-60). Raised from the
  // previous hardcoded 10s to absorb serverless Postgres cold starts.
  connectTimeout?: number | string;
  // Number of times to retry the connection (default 1, clamped 0-3). Retries
  // fire ONLY for pre-query connection failures, so a write is never re-run.
  retries?: number | string;
};

function validateInput(input: DatabaseQueryInput): string | null {
  const queryString = input.dbQuery || input.query;

  if (!queryString || queryString.trim() === "") {
    return "SQL query is required";
  }

  return null;
}

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 30;
const MIN_CONNECT_TIMEOUT_SECONDS = 1;
const MAX_CONNECT_TIMEOUT_SECONDS = 60;
const DEFAULT_RETRIES = 1;
const MIN_RETRIES = 0;
const MAX_RETRIES = 3;
// Short linear backoff between connection attempts; the cold start that timed
// out the first attempt has usually finished warming by the retry.
const RETRY_BACKOFF_MS = 500;

function createDatabaseClient(
  normalizedUrl: string,
  ssl: PostgresSslOption,
  connectTimeoutSeconds: number = DEFAULT_CONNECT_TIMEOUT_SECONDS
): postgres.Sql {
  return postgres(normalizedUrl, {
    max: 1,
    connect_timeout: connectTimeoutSeconds,
    idle_timeout: 20,
    ssl: ssl as false | "require" | "prefer",
  });
}

/** Serialize template-resolved values into types postgres.js can bind directly */
export function serializeSqlParams(
  params: SqlParam[]
): postgres.Serializable[] {
  return params.map((p): postgres.Serializable => {
    if (p === null || p === undefined) {
      return null;
    }
    if (p instanceof Date || p instanceof Uint8Array) {
      return p;
    }
    if (typeof p === "object") {
      return JSON.stringify(p);
    }
    return p;
  });
}

async function executeQuery(
  client: postgres.Sql,
  queryString: string,
  params?: SqlParam[]
): Promise<unknown> {
  if (params && params.length > 0) {
    const serialized = serializeSqlParams(params);
    return await client.unsafe(
      queryString,
      serialized as postgres.ParameterOrJSON<never>[]
    );
  }
  const db = drizzle(client);
  return await db.execute(sql.raw(queryString));
}

async function cleanupClient(client: postgres.Sql | null): Promise<void> {
  if (client) {
    try {
      await client.end();
    } catch {
      // Ignore errors during cleanup
    }
  }
}

/**
 * Resolve the connection timeout in seconds. Accepts the raw config value
 * (numbers from MCP callers, strings from the visual editor), coerces it, and
 * clamps to [1, 60]. Missing / empty / non-numeric falls back to the 30s
 * default. Exported for tests.
 */
export function resolveConnectTimeoutSeconds(connectTimeout: unknown): number {
  if (
    connectTimeout === undefined ||
    connectTimeout === null ||
    connectTimeout === ""
  ) {
    return DEFAULT_CONNECT_TIMEOUT_SECONDS;
  }
  const requested =
    typeof connectTimeout === "number"
      ? connectTimeout
      : Number(connectTimeout);
  if (!Number.isFinite(requested)) {
    return DEFAULT_CONNECT_TIMEOUT_SECONDS;
  }
  return Math.min(
    Math.max(MIN_CONNECT_TIMEOUT_SECONDS, requested),
    MAX_CONNECT_TIMEOUT_SECONDS
  );
}

/**
 * Resolve the retry count. Clamps to [0, 3] and truncates to an integer.
 * Missing / empty / non-numeric falls back to 1. Exported for tests.
 */
export function resolveRetries(retries: unknown): number {
  if (retries === undefined || retries === null || retries === "") {
    return DEFAULT_RETRIES;
  }
  const requested = typeof retries === "number" ? retries : Number(retries);
  if (!Number.isFinite(requested)) {
    return DEFAULT_RETRIES;
  }
  return Math.min(Math.max(MIN_RETRIES, Math.trunc(requested)), MAX_RETRIES);
}

/**
 * Connection errors safe to retry because the query was never sent: the
 * TCP/startup handshake never completed, so re-running cannot double-execute a
 * write. postgres.js raises CONNECT_TIMEOUT when its connect_timeout elapses;
 * ECONNREFUSED means the server is not yet accepting connections (a cold start
 * still spinning up). Ambiguous mid-connection codes (ECONNRESET, ETIMEDOUT)
 * are excluded - they can occur after the query was transmitted.
 */
const RETRYABLE_CONNECTION_CODES = new Set(["CONNECT_TIMEOUT", "ECONNREFUSED"]);
const MAX_CAUSE_DEPTH = 5;

function isRetryableConnectionError(error: unknown): boolean {
  // Walk the error -> cause chain. A direct postgres.js call exposes the code
  // at the top level (`error.code`), but the step's non-parameterized path runs
  // through drizzle, which wraps the driver error so the real code lands on
  // `error.cause.code`. Inspect every level so both paths are covered.
  let current: unknown = error;
  for (
    let depth = 0;
    depth <= MAX_CAUSE_DEPTH && current instanceof Error;
    depth++
  ) {
    // A Postgres query error carries a `severity` (ERROR/FATAL/...): the query
    // reached the server and the failure is deterministic. Never retry it.
    if (
      "severity" in current &&
      typeof (current as { severity: unknown }).severity === "string"
    ) {
      return false;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_CONNECTION_CODES.has(code)) {
      return true;
    }
    // Some driver paths surface the code only in the message.
    if (
      current.message.includes("CONNECT_TIMEOUT") ||
      current.message.includes("ECONNREFUSED")
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Database query logic
 */
async function databaseQuery(
  input: DatabaseQueryInput
): Promise<DatabaseQueryResult> {
  const validationError = validateInput(input);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // Authorize as the ORG principal: the org owns the workflow, so credential
  // use is gated on the org's integrations, not the creating user's.
  // `_context.ownerId` is createdBy attribution only.
  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  const databaseUrl = credentials.DATABASE_URL;

  if (!databaseUrl) {
    return {
      success: false,
      error:
        "DATABASE_URL is not configured. Please add it in Project Integrations.",
    };
  }

  const { normalizedUrl, ssl } = getPostgresConnectionOptions(
    databaseUrl,
    credentials.DATABASE_SSL_MODE
  );

  try {
    await assertConnectionUrlIsPublic(normalizedUrl);
  } catch (guardError) {
    return {
      success: false,
      error:
        guardError instanceof Error
          ? guardError.message
          : "Host is not allowed: must resolve to a public address",
    };
  }

  const queryString = (input.dbQuery || input.query) as string;
  const connectTimeoutSeconds = resolveConnectTimeoutSeconds(
    input.connectTimeout
  );
  const maxAttempts = resolveRetries(input.retries) + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let client: postgres.Sql | null = null;
    try {
      client = createDatabaseClient(normalizedUrl, ssl, connectTimeoutSeconds);
      const result = await executeQuery(client, queryString, input._dbParams);
      return {
        success: true,
        rows: result,
        count: Array.isArray(result) ? result.length : 0,
      };
    } catch (error) {
      lastError = error;
      logUserError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[Database Query] Raw connection error",
        error
      );
      // Retry only pre-query connection failures: a query that already reached
      // the server (or a deterministic SQL error) must not be re-run.
      if (attempt < maxAttempts && isRetryableConnectionError(error)) {
        await sleep(RETRY_BACKOFF_MS * attempt);
        continue;
      }
      return {
        success: false,
        error: `Database query failed: ${getDatabaseErrorMessage(error)}`,
      };
    } finally {
      await cleanupClient(client);
    }
  }

  // The loop returns on success or on the final failure; reachable only if
  // maxAttempts < 1, which resolveRetries prevents.
  return {
    success: false,
    error: `Database query failed: ${getDatabaseErrorMessage(lastError)}`,
  };
}

/**
 * Database Query Step
 * Executes a SQL query against a PostgreSQL database
 */
// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function databaseQueryStep(
  input: DatabaseQueryInput
): Promise<DatabaseQueryResult> {
  "use step";
  return withStepLogging(input, () => databaseQuery(input));
}
databaseQueryStep.maxRetries = 0;
