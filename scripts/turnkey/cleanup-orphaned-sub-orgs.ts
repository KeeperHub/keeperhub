/**
 * Deletes Turnkey sub-organizations that were created by, and are solely
 * owned by, the API key this job runs with. The e2e suites create real
 * sub-orgs on every run and drop their database afterwards, so nothing else
 * ever cleans those sub-orgs up.
 *
 * A sub-org is deleted only when all of these hold:
 *   - no app uses this job's API key: APP_PUBLIC_KEYS holds a valid public
 *     key for every app and none of them is this job's key. Checked once,
 *     before anything else; otherwise the script refuses to run, because an
 *     app's real wallets would look exactly like e2e leftovers
 *   - it still exists under TURNKEY_ORGANIZATION_ID
 *   - its creation activity was signed by this job's API key only
 *   - it is older than MIN_AGE_HOURS and not in EXCLUDE_SUB_ORG_IDS
 *   - every credential of every user in it is this job's API key
 *   - every wallet address in it has zero native and zero supported-token
 *     balance on every enabled mainnet in CHAIN_RPC_CONFIG
 * Any lookup that fails leaves the sub-org in place.
 *
 * Environment:
 *   MODE                      "dry-run" (default in the workflow) or "delete"
 *   EXPECTED_KEY_PREFIX       first 16+ hex characters of the API public key
 *   MAX_SUB_ORGS              dry-run: sub-orgs to inspect; delete: to delete
 *   MIN_AGE_HOURS             skip sub-orgs younger than this (default 6)
 *   REQUESTS_PER_SECOND       Turnkey request rate (default 10, max 30)
 *   EXCLUDE_SUB_ORG_IDS       comma or space separated sub-org ids to keep
 *   APP_PUBLIC_KEYS           comma separated live Turnkey public key of
 *                             every app (staging, which the PR environments
 *                             share, and prod); the workflow reads them
 *                             right before this script runs
 *   TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID
 *   CHAIN_RPC_CONFIG
 *
 * Runs only inside GitHub Actions: .github/workflows/turnkey-sub-org-cleanup.yml
 */

import { appendFileSync } from "node:fs";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Turnkey } from "@turnkey/sdk-server";
import { parseRpcConfig } from "../../lib/rpc/rpc-config";
import { redactAllUrls } from "../../lib/rpc/scrub-rpc-urls";
import { TOKEN_CONFIGS } from "../seed/supported-token-configs";
import {
  type BalanceTarget,
  buildBalanceTargets,
  type CleanupOptions,
  type CreationActivity,
  collectCreationsByKey,
  createRateLimiter,
  createTurnkeyReader,
  describeError,
  encodeBalanceOfCall,
  groupAddresses,
  hasNonZeroTokenAccount,
  isOwnedSolelyByKey,
  isSubOrgNotFound,
  mapWithConcurrency,
  parseHexQuantity,
  parseOptions,
  type SubOrgUser,
  selectCandidates,
  type TokenAccount,
  type WalletAddresses,
  withRetry,
} from "./sub-org-cleanup";

const TURNKEY_API_BASE_URL = "https://api.turnkey.com";
const PAGE_SIZE = 100;
const CHUNK_SIZE = 100;
const RPC_BATCH_SIZE = 50;
const RPC_ATTEMPTS = 3;
const RPC_RETRY_BASE_MS = 1000;
const MAX_CONSECUTIVE_TURNKEY_ERRORS = 25;
const PRINT_IDS_UP_TO = 5;
const READ_ATTEMPTS = 5;
const READ_RETRY_BASE_MS = 2000;

type TurnkeyClient = ReturnType<Turnkey["apiClient"]>;

type Counters = {
  listed: number;
  createdByKey: number;
  excluded: number;
  tooYoung: number;
  candidates: number;
  inspected: number;
  alreadyGone: number;
  notSolelyOwned: number;
  unsupportedAddress: number;
  balanceUnknown: number;
  funded: number;
  eligible: number;
  addressesEligible: number;
  deleted: number;
  addressesDeleted: number;
  deleteFailed: number;
  turnkeyErrors: number;
};

type Inspection =
  | { status: "gone" | "not-owned" | "unsupported" | "error" }
  | { status: "ok"; subOrgId: string; addresses: WalletAddresses };

/** For logging only: decisions use the full, untruncated error text. */
function safeMessage(error: unknown): string {
  return redactAllUrls(describeError(error)).slice(0, 300);
}

type TurnkeyRead = <T>(call: () => Promise<T>) => Promise<T>;

async function listSubOrgIds(
  client: TurnkeyClient,
  organizationId: string,
  read: TurnkeyRead
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await read(() =>
      client.getSubOrgIds({
        organizationId,
        paginationOptions: {
          limit: String(PAGE_SIZE),
          ...(after && { after }),
        },
      })
    );
    const pageIds = page.organizationIds ?? [];
    ids.push(...pageIds);
    if (pageIds.length < PAGE_SIZE) {
      return ids;
    }
    after = pageIds.at(-1);
  }
}

async function listCreationActivities(
  client: TurnkeyClient,
  organizationId: string,
  read: TurnkeyRead
): Promise<CreationActivity[]> {
  const activities: CreationActivity[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await read(() =>
      client.getActivities({
        organizationId,
        filterByType: [
          "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION",
          "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V2",
          "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V3",
          "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4",
          "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V5",
          "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V6",
          "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V7",
        ],
        paginationOptions: {
          limit: String(PAGE_SIZE),
          ...(after && { after }),
        },
      })
    );
    const pageActivities = page.activities ?? [];
    activities.push(...(pageActivities as CreationActivity[]));
    if (pageActivities.length < PAGE_SIZE) {
      return activities;
    }
    after = pageActivities.at(-1)?.id;
  }
}

type RpcResponse = { id: number; result?: unknown; error?: unknown }[];

/**
 * Posts a JSON-RPC batch, alternating between the primary and fallback URL.
 * Returns undefined when every attempt fails, so the caller marks those
 * balances unknown. Errors are not logged: they can carry the RPC URL, which
 * holds an API key.
 */
async function postJsonRpc(
  urls: string[],
  body: unknown[]
): Promise<RpcResponse | undefined> {
  let attempt = 0;
  try {
    return await withRetry(
      async () => {
        const url = urls[attempt % urls.length];
        attempt += 1;
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json: unknown = await response.json();
        if (!(response.ok && Array.isArray(json))) {
          throw new Error(`RPC batch failed with HTTP ${response.status}`);
        }
        return json as RpcResponse;
      },
      { attempts: RPC_ATTEMPTS, baseDelayMs: RPC_RETRY_BASE_MS }
    );
  } catch {
    return;
  }
}

type RpcCall = { method: string; params: unknown[]; address: string };

/**
 * Sends `calls` in batches and returns the addresses that hold funds and the
 * addresses whose balance could not be read.
 */
async function runBalanceCalls(
  target: BalanceTarget,
  calls: RpcCall[],
  isFunded: (method: string, result: unknown) => boolean | undefined
): Promise<{ funded: Set<string>; unknown: Set<string> }> {
  const funded = new Set<string>();
  const unknown = new Set<string>();
  for (let start = 0; start < calls.length; start += RPC_BATCH_SIZE) {
    const batch = calls.slice(start, start + RPC_BATCH_SIZE);
    const response = await postJsonRpc(
      target.urls,
      batch.map((call, id) => ({
        jsonrpc: "2.0",
        id,
        method: call.method,
        params: call.params,
      }))
    );
    const byId = new Map((response ?? []).map((item) => [item.id, item]));
    for (const [id, call] of batch.entries()) {
      const item = byId.get(id);
      const verdict =
        item && item.error === undefined
          ? isFunded(call.method, item.result)
          : undefined;
      if (verdict === undefined) {
        unknown.add(call.address);
      } else if (verdict) {
        funded.add(call.address);
      }
    }
  }
  return { funded, unknown };
}

function evmCalls(target: BalanceTarget, addresses: string[]): RpcCall[] {
  const calls: RpcCall[] = [];
  for (const address of addresses) {
    if (target.checkNative) {
      calls.push({
        method: "eth_getBalance",
        params: [address, "latest"],
        address,
      });
    }
    for (const token of target.tokenAddresses) {
      calls.push({
        method: "eth_call",
        params: [{ to: token, data: encodeBalanceOfCall(address) }, "latest"],
        address,
      });
    }
  }
  return calls;
}

function solanaCalls(addresses: string[]): RpcCall[] {
  const calls: RpcCall[] = [];
  for (const address of addresses) {
    calls.push({ method: "getBalance", params: [address], address });
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      calls.push({
        method: "getTokenAccountsByOwner",
        params: [
          address,
          { programId: programId.toBase58() },
          { encoding: "jsonParsed" },
        ],
        address,
      });
    }
  }
  return calls;
}

function solanaVerdict(method: string, result: unknown): boolean | undefined {
  const value = (result as { value?: unknown } | null)?.value;
  if (method === "getBalance") {
    return typeof value === "number" ? value > 0 : undefined;
  }
  return Array.isArray(value)
    ? hasNonZeroTokenAccount(value as TokenAccount[])
    : undefined;
}

function evmVerdict(_method: string, result: unknown): boolean | undefined {
  const amount = parseHexQuantity(result);
  return amount === undefined ? undefined : amount > BigInt(0);
}

/** Checks every address of every inspected sub-org on every mainnet. */
async function checkBalances(
  targets: BalanceTarget[],
  inspected: { subOrgId: string; addresses: WalletAddresses }[],
  fundedByChain: Map<string, number>
): Promise<{ funded: Set<string>; unknown: Set<string> }> {
  const evmAddresses = inspected.flatMap((item) => item.addresses.evm);
  const solanaAddresses = inspected.flatMap((item) => item.addresses.solana);
  const funded = new Set<string>();
  const unknown = new Set<string>();
  for (const target of targets) {
    const result =
      target.kind === "solana"
        ? await runBalanceCalls(
            target,
            solanaCalls(solanaAddresses),
            solanaVerdict
          )
        : await runBalanceCalls(
            target,
            evmCalls(target, evmAddresses),
            evmVerdict
          );
    for (const address of result.funded) {
      funded.add(address);
    }
    for (const address of result.unknown) {
      unknown.add(address);
    }
    if (result.funded.size > 0) {
      fundedByChain.set(
        target.name,
        (fundedByChain.get(target.name) ?? 0) + result.funded.size
      );
    }
  }
  return { funded, unknown };
}

function writeSummary(
  options: CleanupOptions,
  targets: BalanceTarget[],
  counters: Counters,
  fundedByChain: Map<string, number>,
  deletedIds: string[]
): void {
  const lines = [
    `## Turnkey sub-org cleanup (${options.mode})`,
    "",
    "| Step | Count |",
    "| --- | --- |",
    ...Object.entries(counters).map(([name, value]) => `| ${name} | ${value} |`),
    "",
    `Mainnets checked: ${targets.map((target) => target.name).join(", ")}`,
    `Funded addresses by chain: ${
      fundedByChain.size === 0
        ? "none"
        : [...fundedByChain].map(([name, count]) => `${name}=${count}`).join(", ")
    }`,
  ];
  if (deletedIds.length > 0 && deletedIds.length <= PRINT_IDS_UP_TO) {
    lines.push(`Deleted sub-orgs: ${deletedIds.join(", ")}`);
  }
  const text = lines.join("\n");
  console.log(text);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, `${text}\n`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.env);
  const targets = buildBalanceTargets(
    parseRpcConfig(options.rpcConfigValue),
    TOKEN_CONFIGS
  );
  const limit = createRateLimiter(options.requestsPerSecond);
  const clientFor = (organizationId: string): TurnkeyClient =>
    new Turnkey({
      apiBaseUrl: TURNKEY_API_BASE_URL,
      apiPublicKey: options.apiPublicKey,
      apiPrivateKey: options.apiPrivateKey,
      defaultOrganizationId: organizationId,
    }).apiClient();
  const parent = clientFor(options.organizationId);
  const read = createTurnkeyReader(limit, {
    attempts: READ_ATTEMPTS,
    baseDelayMs: READ_RETRY_BASE_MS,
  });

  const counters: Counters = {
    listed: 0,
    createdByKey: 0,
    excluded: 0,
    tooYoung: 0,
    candidates: 0,
    inspected: 0,
    alreadyGone: 0,
    notSolelyOwned: 0,
    unsupportedAddress: 0,
    balanceUnknown: 0,
    funded: 0,
    eligible: 0,
    addressesEligible: 0,
    deleted: 0,
    addressesDeleted: 0,
    deleteFailed: 0,
    turnkeyErrors: 0,
  };
  const fundedByChain = new Map<string, number>();
  const deletedIds: string[] = [];

  const listed = await listSubOrgIds(parent, options.organizationId, read);
  const createdByKey = collectCreationsByKey(
    await listCreationActivities(parent, options.organizationId, read),
    options.apiPublicKey
  );
  const selection = selectCandidates({
    listedSubOrgIds: listed,
    createdByKey,
    excludedSubOrgIds: options.excludedSubOrgIds,
    nowMs: Date.now(),
    minAgeHours: options.minAgeHours,
  });
  counters.listed = listed.length;
  counters.createdByKey = createdByKey.size;
  counters.excluded = selection.excluded;
  counters.tooYoung = selection.tooYoung;
  counters.candidates = selection.candidates.length;

  let consecutiveErrors = 0;
  const onTurnkeyError = (operation: string, error: unknown): void => {
    counters.turnkeyErrors += 1;
    consecutiveErrors += 1;
    console.log(`[Turnkey] ${operation} failed: ${safeMessage(error)}`);
    if (consecutiveErrors >= MAX_CONSECUTIVE_TURNKEY_ERRORS) {
      throw new Error(
        `Stopping after ${MAX_CONSECUTIVE_TURNKEY_ERRORS} Turnkey errors in a row`
      );
    }
  };

  const inspect = async (subOrgId: string): Promise<Inspection> => {
    try {
      const { users } = await read(() =>
        parent.getUsers({ organizationId: subOrgId })
      );
      if (!isOwnedSolelyByKey(users as SubOrgUser[], options.apiPublicKey)) {
        consecutiveErrors = 0;
        return { status: "not-owned" };
      }
      const { accounts } = await read(() =>
        parent.getWalletAccounts({
          organizationId: subOrgId,
          paginationOptions: { limit: String(PAGE_SIZE) },
        })
      );
      consecutiveErrors = 0;
      const addresses = groupAddresses(accounts ?? []);
      if (addresses.unsupported.length > 0) {
        return { status: "unsupported" };
      }
      return { status: "ok", subOrgId, addresses };
    } catch (error) {
      if (isSubOrgNotFound(error)) {
        consecutiveErrors = 0;
        return { status: "gone" };
      }
      onTurnkeyError("inspect", error);
      return { status: "error" };
    }
  };

  const remove = async (subOrgId: string, addressCount: number) => {
    try {
      await limit();
      const response = await clientFor(subOrgId).deleteSubOrganization({
        organizationId: subOrgId,
        deleteWithoutExport: true,
      });
      consecutiveErrors = 0;
      if (response.activity?.status === "ACTIVITY_STATUS_COMPLETED") {
        counters.deleted += 1;
        counters.addressesDeleted += addressCount;
        deletedIds.push(subOrgId);
      } else {
        counters.deleteFailed += 1;
        console.log(
          `[Turnkey] delete returned status ${response.activity?.status}`
        );
      }
    } catch (error) {
      counters.deleteFailed += 1;
      onTurnkeyError("delete", error);
    }
  };

  const concurrency = Math.max(1, Math.ceil(options.requestsPerSecond));
  const budgetReached = (): boolean =>
    options.mode === "delete"
      ? counters.deleted + counters.deleteFailed >= options.maxSubOrgs
      : counters.inspected >= options.maxSubOrgs;

  for (
    let start = 0;
    start < selection.candidates.length && !budgetReached();
    start += CHUNK_SIZE
  ) {
    const room =
      options.mode === "dry-run"
        ? options.maxSubOrgs - counters.inspected
        : CHUNK_SIZE;
    const chunk = selection.candidates.slice(
      start,
      start + Math.min(CHUNK_SIZE, room)
    );
    const inspections = await mapWithConcurrency(chunk, concurrency, inspect);
    counters.inspected += chunk.length;

    const usable: { subOrgId: string; addresses: WalletAddresses }[] = [];
    for (const inspection of inspections) {
      if (inspection.status === "gone") {
        counters.alreadyGone += 1;
      } else if (inspection.status === "not-owned") {
        counters.notSolelyOwned += 1;
      } else if (inspection.status === "unsupported") {
        counters.unsupportedAddress += 1;
      } else if (inspection.status === "ok") {
        usable.push(inspection);
      }
    }

    const balances = await checkBalances(targets, usable, fundedByChain);
    const eligible: { subOrgId: string; addressCount: number }[] = [];
    for (const item of usable) {
      const all = [...item.addresses.evm, ...item.addresses.solana];
      if (all.some((address) => balances.funded.has(address))) {
        counters.funded += 1;
      } else if (all.some((address) => balances.unknown.has(address))) {
        counters.balanceUnknown += 1;
      } else {
        counters.eligible += 1;
        counters.addressesEligible += all.length;
        eligible.push({ subOrgId: item.subOrgId, addressCount: all.length });
      }
    }

    if (options.mode === "delete") {
      const room =
        options.maxSubOrgs - counters.deleted - counters.deleteFailed;
      await mapWithConcurrency(eligible.slice(0, room), concurrency, (item) =>
        remove(item.subOrgId, item.addressCount)
      );
    }
    console.log(
      `[Cleanup] progress inspected=${counters.inspected} eligible=${counters.eligible} deleted=${counters.deleted}`
    );
  }

  writeSummary(options, targets, counters, fundedByChain, deletedIds);
  if (counters.deleteFailed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`[Cleanup] aborted: ${safeMessage(error)}`);
  process.exit(1);
});
