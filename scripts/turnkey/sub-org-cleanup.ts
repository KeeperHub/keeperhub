/**
 * Pure helpers for scripts/turnkey/cleanup-orphaned-sub-orgs.ts.
 *
 * Kept free of network and SDK side effects so the selection and safety rules
 * can be unit tested.
 */

import type { RpcConfig } from "../../lib/rpc/rpc-config";
import type { TokenConfig } from "../seed/supported-token-configs";

type Env = Readonly<Record<string, string | undefined>>;

export type CleanupMode = "dry-run" | "delete";

export type CleanupOptions = {
  mode: CleanupMode;
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  rpcConfigValue: string;
  maxSubOrgs: number;
  minAgeHours: number;
  requestsPerSecond: number;
  excludedSubOrgIds: Set<string>;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_PREFIX_PATTERN = /^[0-9a-f]{16,}$/i;
const LIST_SEPARATOR = /[\s,]+/;
const MAX_REQUESTS_PER_SECOND = 30;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseNumber(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

/**
 * Reads and validates every input. Throws on anything missing or malformed,
 * so the script never runs with a partial configuration.
 */
export function parseOptions(env: Env): CleanupOptions {
  if (env.GITHUB_ACTIONS !== "true") {
    throw new Error("This script only runs inside GitHub Actions");
  }

  const mode = required(env, "MODE");
  if (mode !== "dry-run" && mode !== "delete") {
    throw new Error('MODE must be "dry-run" or "delete"');
  }

  const apiPublicKey = required(env, "TURNKEY_API_PUBLIC_KEY");
  const expectedPrefix = required(env, "EXPECTED_KEY_PREFIX");
  if (!KEY_PREFIX_PATTERN.test(expectedPrefix)) {
    throw new Error(
      "EXPECTED_KEY_PREFIX must be at least 16 hex characters of the API public key"
    );
  }
  if (!apiPublicKey.toLowerCase().startsWith(expectedPrefix.toLowerCase())) {
    throw new Error(
      "EXPECTED_KEY_PREFIX does not match the API public key this job runs with"
    );
  }

  const maxSubOrgs = parseNumber(
    env,
    "MAX_SUB_ORGS",
    1,
    1,
    Number.MAX_SAFE_INTEGER
  );
  if (!Number.isInteger(maxSubOrgs)) {
    throw new Error("MAX_SUB_ORGS must be a whole number");
  }

  const excludedSubOrgIds = new Set<string>();
  for (const id of (env.EXCLUDE_SUB_ORG_IDS ?? "").split(LIST_SEPARATOR)) {
    if (!id) {
      continue;
    }
    if (!UUID_PATTERN.test(id)) {
      throw new Error(`EXCLUDE_SUB_ORG_IDS has an invalid id: ${id}`);
    }
    excludedSubOrgIds.add(id.toLowerCase());
  }

  return {
    mode,
    organizationId: required(env, "TURNKEY_ORGANIZATION_ID"),
    apiPublicKey,
    apiPrivateKey: required(env, "TURNKEY_API_PRIVATE_KEY"),
    rpcConfigValue: required(env, "CHAIN_RPC_CONFIG"),
    maxSubOrgs,
    minAgeHours: parseNumber(env, "MIN_AGE_HOURS", 6, 1, 24 * 365),
    requestsPerSecond: parseNumber(
      env,
      "REQUESTS_PER_SECOND",
      10,
      1,
      MAX_REQUESTS_PER_SECOND
    ),
    excludedSubOrgIds,
  };
}

/** The subset of a Turnkey activity this script reads. */
export type CreationActivity = {
  status?: string;
  type?: string;
  createdAt?: { seconds?: string };
  votes?: { publicKey?: string }[];
  result?: Record<string, { subOrganizationId?: string } | undefined>;
};

/**
 * Maps sub-org id to creation time (ms) for every completed sub-org creation
 * that was signed by `publicKey`.
 */
export function collectCreationsByKey(
  activities: CreationActivity[],
  publicKey: string
): Map<string, number> {
  const key = publicKey.toLowerCase();
  const created = new Map<string, number>();
  for (const activity of activities) {
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
      continue;
    }
    if (!activity.type?.startsWith("ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION")) {
      continue;
    }
    const signers = (activity.votes ?? []).map((vote) =>
      vote.publicKey?.toLowerCase()
    );
    if (signers.length === 0 || signers.some((signer) => signer !== key)) {
      continue;
    }
    const subOrgId = Object.values(activity.result ?? {}).find(
      (value) => value?.subOrganizationId
    )?.subOrganizationId;
    const seconds = Number(activity.createdAt?.seconds);
    if (!(subOrgId && Number.isFinite(seconds) && seconds > 0)) {
      continue;
    }
    created.set(subOrgId.toLowerCase(), seconds * 1000);
  }
  return created;
}

export type CandidateSelection = {
  candidates: string[];
  excluded: number;
  tooYoung: number;
  notCreatedByKey: number;
};

/**
 * Picks the sub-orgs that still exist, were created by this job's key, are
 * older than the minimum age, and are not excluded.
 */
export function selectCandidates(input: {
  listedSubOrgIds: string[];
  createdByKey: Map<string, number>;
  excludedSubOrgIds: Set<string>;
  nowMs: number;
  minAgeHours: number;
}): CandidateSelection {
  const cutoffMs = input.nowMs - input.minAgeHours * 60 * 60 * 1000;
  const result: CandidateSelection = {
    candidates: [],
    excluded: 0,
    tooYoung: 0,
    notCreatedByKey: 0,
  };
  for (const rawId of input.listedSubOrgIds) {
    const id = rawId.toLowerCase();
    const createdAtMs = input.createdByKey.get(id);
    if (createdAtMs === undefined) {
      result.notCreatedByKey += 1;
    } else if (input.excludedSubOrgIds.has(id)) {
      result.excluded += 1;
    } else if (createdAtMs > cutoffMs) {
      result.tooYoung += 1;
    } else {
      result.candidates.push(id);
    }
  }
  return result;
}

/** The subset of a Turnkey user this script reads. */
export type SubOrgUser = {
  apiKeys?: { credential?: { publicKey?: string } }[];
  authenticators?: unknown[];
  oauthProviders?: unknown[];
};

/**
 * True only when every credential on every user of the sub-org is this one
 * API key. Any other key, passkey, or OAuth login means someone else can use
 * the sub-org, so it is not ours to delete.
 */
export function isOwnedSolelyByKey(
  users: SubOrgUser[],
  publicKey: string
): boolean {
  const key = publicKey.toLowerCase();
  if (users.length === 0) {
    return false;
  }
  let keyCount = 0;
  for (const user of users) {
    if ((user.authenticators ?? []).length > 0) {
      return false;
    }
    if ((user.oauthProviders ?? []).length > 0) {
      return false;
    }
    for (const apiKey of user.apiKeys ?? []) {
      if (apiKey.credential?.publicKey?.toLowerCase() !== key) {
        return false;
      }
      keyCount += 1;
    }
  }
  return keyCount > 0;
}

export type WalletAddresses = {
  evm: string[];
  solana: string[];
  unsupported: string[];
};

export function groupAddresses(
  accounts: { address?: string; addressFormat?: string }[]
): WalletAddresses {
  const grouped: WalletAddresses = { evm: [], solana: [], unsupported: [] };
  for (const account of accounts) {
    if (!account.address) {
      grouped.unsupported.push(account.addressFormat ?? "unknown");
    } else if (account.addressFormat === "ADDRESS_FORMAT_ETHEREUM") {
      grouped.evm.push(account.address.toLowerCase());
    } else if (account.addressFormat === "ADDRESS_FORMAT_SOLANA") {
      grouped.solana.push(account.address);
    } else {
      grouped.unsupported.push(account.addressFormat ?? "unknown");
    }
  }
  return grouped;
}

export const SOLANA_MAINNET_CHAIN_ID = 101;

// Tempo has no native token. eth_getBalance there returns a fixed placeholder
// for every address, so only its ERC-20 balances are meaningful.
export const CHAINS_WITHOUT_NATIVE_BALANCE: ReadonlySet<number> = new Set([
  4217,
]);

export type BalanceTarget = {
  name: string;
  chainId: number;
  kind: "evm" | "solana";
  urls: string[];
  checkNative: boolean;
  tokenAddresses: string[];
};

/**
 * Builds one balance-check target per enabled mainnet chain in the RPC
 * config. Throws when Solana or every EVM chain is missing, because a check
 * that silently skips a chain could approve a funded wallet for deletion.
 */
export function buildBalanceTargets(
  rpcConfig: RpcConfig,
  tokens: TokenConfig[]
): BalanceTarget[] {
  const targets: BalanceTarget[] = [];
  for (const [name, entry] of Object.entries(rpcConfig)) {
    // An entry without isTestnet is checked: a needless check costs a few
    // calls, a skipped mainnet could delete a funded wallet.
    if (entry.isEnabled === false || entry.isTestnet === true) {
      continue;
    }
    const chainId = entry.chainId;
    const urls = [entry.primaryRpcUrl, entry.fallbackRpcUrl].filter(
      (url): url is string => Boolean(url)
    );
    if (chainId === undefined || urls.length === 0) {
      throw new Error(`RPC config entry ${name} has no chainId or RPC URL`);
    }
    const isSolana = chainId === SOLANA_MAINNET_CHAIN_ID;
    targets.push({
      name,
      chainId,
      kind: isSolana ? "solana" : "evm",
      urls,
      checkNative: !CHAINS_WITHOUT_NATIVE_BALANCE.has(chainId),
      tokenAddresses: isSolana
        ? []
        : tokens
            .filter((token) => token.chainId === chainId)
            .map((token) => token.tokenAddress.toLowerCase()),
    });
  }
  if (!targets.some((target) => target.kind === "solana")) {
    throw new Error("RPC config has no enabled Solana mainnet entry");
  }
  if (!targets.some((target) => target.kind === "evm")) {
    throw new Error("RPC config has no enabled EVM mainnet entry");
  }
  return targets;
}

const HEX_QUANTITY = /^0x[0-9a-f]*$/i;

/**
 * Parses a JSON-RPC hex quantity. "0x" (an empty eth_call return, for example
 * from an address with no contract) counts as zero. Returns undefined for
 * anything that is not hex, so the caller treats it as an unknown balance.
 */
export function parseHexQuantity(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) {
    return;
  }
  return value === "0x" ? BigInt(0) : BigInt(value);
}

export function encodeBalanceOfCall(address: string): string {
  return `0x70a08231${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

export type TokenAccount = {
  account?: {
    data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } };
  };
};

/** True when any SPL token account holds a non-zero amount. */
export function hasNonZeroTokenAccount(accounts: TokenAccount[]): boolean {
  return accounts.some((entry) => {
    const amount = entry.account?.data?.parsed?.info?.tokenAmount?.amount;
    return amount !== undefined && amount !== "0";
  });
}

/**
 * Spaces calls evenly so the whole run stays under `perSecond`, no matter how
 * many workers share the limiter.
 */
export function createRateLimiter(
  perSecond: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): () => Promise<void> {
  const intervalMs = 1000 / perSecond;
  let nextSlotMs = 0;
  return async () => {
    const current = now();
    const slot = Math.max(current, nextSlotMs);
    nextSlotMs = slot + intervalMs;
    if (slot > current) {
      await sleep(slot - current);
    }
  };
}

/** Runs `worker` over `items` with at most `concurrency` calls in flight. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, run)
  );
  return results;
}

/**
 * Formats an error for the job log. Node's fetch reports network failures as
 * a bare "fetch failed" and keeps the reason (ECONNRESET, ETIMEDOUT, ...) in
 * `cause`, so the cause code is appended. URLs are left to the caller to
 * redact.
 */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const reason = causeCode(cause) ?? causeMessage(cause);
  return reason ? `${message} (${reason})` : message;
}

function causeCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object" || !("code" in cause)) {
    return;
  }
  const code = (cause as { code: unknown }).code;
  if (typeof code === "number" || (typeof code === "string" && code !== "")) {
    return String(code);
  }
  return;
}

function causeMessage(cause: unknown): string | undefined {
  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : undefined;
}

const SUB_ORG_NOT_FOUND = "no organization found";

/** True when Turnkey says the sub-org does not exist (any more). */
export function isSubOrgNotFound(error: unknown): boolean {
  return describeError(error).includes(SUB_ORG_NOT_FOUND);
}

// Turnkey API errors carry a gRPC status code. These four are the ones that
// can succeed on a later attempt: DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED
// (rate limit), INTERNAL and UNAVAILABLE.
const TRANSIENT_TURNKEY_CODES: ReadonlySet<number> = new Set([4, 8, 13, 14]);
const HTTP_STATUS_PREFIX = /^(\d{3}) /;

/**
 * True for errors a retry can fix: a network failure (fetch puts the reason
 * code in `cause`), a Turnkey rate limit or server error, or an HTTP 429 or
 * 5xx that came back without a JSON body. Auth, permission and validation
 * errors are final.
 */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (causeCode(error.cause)) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number") {
    return TRANSIENT_TURNKEY_CODES.has(code);
  }
  const status = Number(HTTP_STATUS_PREFIX.exec(error.message)?.[1]);
  return status === 429 || status >= 500;
}

export function shouldRetryTurnkeyRead(error: unknown): boolean {
  return !isSubOrgNotFound(error) && isTransientError(error);
}

/**
 * Builds the wrapper for every Turnkey read. Each attempt, retries included,
 * waits for the rate limiter first, so retries never push the job above its
 * configured rate.
 */
export function createTurnkeyReader(
  limit: () => Promise<void>,
  options: {
    attempts: number;
    baseDelayMs: number;
    sleep?: (ms: number) => Promise<void>;
  }
): <T>(call: () => Promise<T>) => Promise<T> {
  return (call) =>
    withRetry(
      async () => {
        await limit();
        return call();
      },
      { ...options, shouldRetry: shouldRetryTurnkeyRead }
    );
}

/**
 * Retries a call with growing pauses and no pause after the last attempt.
 * Only for idempotent calls: `shouldRetry` stops on errors that will not
 * change.
 */
export async function withRetry<T>(
  call: () => Promise<T>,
  options: {
    attempts: number;
    baseDelayMs: number;
    shouldRetry?: (error: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<T> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const retryable = options.shouldRetry?.(error) ?? true;
      if (!retryable || attempt >= options.attempts) {
        throw error;
      }
      await sleep(options.baseDelayMs * attempt);
    }
  }
}
