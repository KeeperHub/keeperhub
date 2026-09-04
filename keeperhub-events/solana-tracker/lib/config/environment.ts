import { logger } from "../utils/logger";

export const KEEPERHUB_API_URL: string = process.env.KEEPERHUB_API_URL || "";
export const REDIS_HOST: string = process.env.REDIS_HOST || "localhost";
export const REDIS_PORT: number = Number(process.env.REDIS_PORT) || 6379;
export const REDIS_PASSWORD: string = process.env.REDIS_PASSWORD || "";
export const JWT_TOKEN_USERNAME: string = process.env.JWT_TOKEN_USERNAME || "";
export const JWT_TOKEN_PASSWORD: string = process.env.JWT_TOKEN_PASSWORD || "";
export const ETHERSCAN_API_KEY: string = process.env.ETHERSCAN_API_KEY || "";
export const NODE_ENV: string = process.env.NODE_ENV || "development";

/**
 * Floor on how often the signatures source queries each watched program. The
 * slot tick alone would drive it as fast as RPC latency allows (~2.5 slots/s on
 * Solana mainnet, one query per program per poll), which is a large sustained
 * RPC bill for no latency gain that matters downstream of SQS.
 */
export const SOLANA_SIGNATURES_POLL_INTERVAL_MS: number = parseDurationMs(
  "SOLANA_SIGNATURES_POLL_INTERVAL_MS",
  process.env.SOLANA_SIGNATURES_POLL_INTERVAL_MS,
  2000,
);

/**
 * How long a watched program may go without a poll that completes before the
 * signatures source drops its cursor and re-seeds to head.
 *
 * The precise recovery keys off the RPC's "transaction not found" code, but an
 * endpoint that reports an unresolvable cursor some other way would otherwise
 * stall that program forever - the cursor is only ever advanced on success, so
 * a rejected cursor is retried unchanged on every poll. This backstop bounds
 * that by wall-clock instead of by error shape. Re-seeding skips the window, so
 * the value trades event loss against how long a program may stay stuck. An
 * explicit 0 is honoured and means "re-seed on the first failed poll"; it does
 * not disable the backstop.
 */
export const SOLANA_SIGNATURES_STALL_RESET_MS: number = parseDurationMs(
  "SOLANA_SIGNATURES_STALL_RESET_MS",
  process.env.SOLANA_SIGNATURES_STALL_RESET_MS,
  300_000,
);

/**
 * `Number(x) || fallback` would swallow an explicit `0` - the value an operator
 * uses to disable a floor - and would silently accept a typo as the default.
 * Honour any finite non-negative number, and say so when a value is rejected.
 * The variable name is a parameter so the warning names the one that was wrong.
 */
function parseDurationMs(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(
      `[env] ${name}="${raw}" is not a non-negative number; using ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

export const SQS_QUEUE_URL: string = process.env.SQS_QUEUE_URL || "";
export const AWS_REGION: string = process.env.AWS_REGION || "us-east-1";
export const AWS_ENDPOINT_URL: string | undefined =
  process.env.AWS_ENDPOINT_URL;
