/**
 * Setup runner for protocol-coverage tests (KEEP-458).
 *
 * Called from each `coverage.test.ts`'s `beforeAll`. Looks up the persistent
 * test user's Turnkey wallet address from `organization_wallets`, runs the
 * native-gas preflight, then executes the programmatically-built setup
 * workflow. The wallet address is stashed on `SharedCtx` so the read/write
 * runners reuse it without a second DB round-trip.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseUrl } from "@/lib/db/connection-utils";
import { organization } from "@/lib/db/schema";
import { organizationWallets } from "@/lib/db/schema-extensions";
import { getProtocol } from "@/lib/protocol-registry";
import {
  buildSetupWorkflow,
  toWebhookTriggered,
} from "@/lib/test-data/build-workflow";
import {
  createApiKey,
  createTestWorkflow,
  deleteApiKey,
  deleteTestWorkflow,
  getWorkflowWebhookUrl,
  PERSISTENT_TEST_ORG_SLUG,
  PERSISTENT_TEST_USER_EMAIL,
  waitForWorkflowExecution,
} from "@/tests/utils/db";
import {
  ensureErc20Acquired,
  ensureNativeGas,
  runFabricatedApprovals,
  runForkImpersonatedCalls,
} from "./funding";

export type SharedCtx = {
  apiKey?: string;
  walletAddress?: string;
  workflowIds: string[];
};

export function createSharedCtx(): SharedCtx {
  return { workflowIds: [] };
}

/** Look up the persistent test user's active wallet address. Throws when
 *  the seed hasn't run (or Turnkey provisioning was skipped). */
async function getTestWalletAddress(): Promise<string> {
  const client = postgres(getDatabaseUrl(), { max: 1 });
  try {
    const db = drizzle(client);
    const [row] = await db
      .select({ walletAddress: organizationWallets.walletAddress })
      .from(organizationWallets)
      .innerJoin(
        organization,
        eq(organization.id, organizationWallets.organizationId)
      )
      .where(
        and(
          eq(organization.slug, PERSISTENT_TEST_ORG_SLUG),
          eq(organizationWallets.isActive, true)
        )
      )
      .limit(1);
    if (!row?.walletAddress) {
      throw new Error(
        `No active wallet for org "${PERSISTENT_TEST_ORG_SLUG}". ` +
          "Run `pnpm db:seed-test-wallet` (with TURNKEY_* env vars in scope) first."
      );
    }
    return row.walletAddress;
  } finally {
    await client.end();
  }
}

export async function runSetup(opts: {
  protocol: string;
  chainId: string;
  ctx: SharedCtx;
}): Promise<void> {
  const { protocol, chainId, ctx } = opts;

  if (!ctx.walletAddress) {
    ctx.walletAddress = await getTestWalletAddress();
  }
  const walletAddress = ctx.walletAddress;

  const protocolDef = getProtocol(protocol);
  const chainData = protocolDef?.testData?.[chainId];
  const setupSpec = chainData?.setup;
  if (!setupSpec) {
    throw new Error(`No setup spec for ${protocol} on chain ${chainId}.`);
  }

  // Native gas is only needed if the wallet will actually sign a
  // transaction: a setup approval, a setup protocol step, or a write
  // action that isn't skipped. A protocol whose coverage on this chain is
  // 100% reads (e.g. ajna on Base mainnet) never submits anything, so
  // skip the funder/balance preflight entirely rather than requiring a
  // funded wallet for gas that will never be spent.
  const needsGas =
    setupSpec.approvals.length > 0 ||
    (setupSpec.protocolSteps?.length ?? 0) > 0 ||
    (protocolDef?.actions.some(
      (action) =>
        action.type === "write" &&
        chainData?.skipped?.[action.slug] === undefined
    ) ??
      false);
  if (needsGas) {
    await ensureNativeGas(chainId, walletAddress);
  }

  for (const required of setupSpec.requiredTokens) {
    await ensureErc20Acquired(
      chainId,
      walletAddress,
      required.symbol,
      required.human
    );
  }

  // Fork-only privileged provisioning (impersonated wards etc.); no-op
  // when the protocol declares none, throws on a non-fork chain.
  await runForkImpersonatedCalls(protocol, chainId, walletAddress);

  // Fork-only setup allowances written straight to storage, so the setup
  // workflow never submits a slow approve-token transaction; no-op when
  // the protocol declares none.
  await runFabricatedApprovals(protocol, chainId, walletAddress);

  const setupWf = toWebhookTriggered(
    buildSetupWorkflow({ protocolSlug: protocol, chainId, walletAddress })
  );

  if (!ctx.apiKey) {
    ctx.apiKey = await createApiKey(PERSISTENT_TEST_USER_EMAIL);
  }

  const workflow = await createTestWorkflow(PERSISTENT_TEST_USER_EMAIL, {
    name: setupWf.name,
    description: setupWf.description,
    nodes: setupWf.nodes,
    edges: setupWf.edges,
    triggerType: "webhook",
  });
  ctx.workflowIds.push(workflow.id);

  const baseUrl = process.env.PROTOCOL_E2E_BASE_URL ?? "http://localhost:3000";
  const url = getWorkflowWebhookUrl(workflow.id, baseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.apiKey}`,
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(
      `setup webhook ${url} returned ${response.status}: ${await response.text()}`
    );
  }

  // 300s: forked chains lazy-load contract state from their upstream on
  // first touch, so the first transaction through a protocol's contracts
  // can be far slower than steady-state (observed >180s on the Sepolia
  // fork with the default public upstream). Setups with several
  // transactions can override via setup.executionWaitMs (see SetupSpec).
  const result = await waitForWorkflowExecution(
    workflow.id,
    setupSpec.executionWaitMs ?? 300_000
  );
  if (result?.status !== "success") {
    const diagnosis = await describeExecutionState(workflow.id);
    throw new Error(
      `setup workflow failed for ${protocol}/${chainId}: ${result?.status ?? "timeout"}${result?.error ? ` - ${result.error}` : ""}\n${diagnosis}`
    );
  }
}

/** Pre-cleanup post-mortem for setup failures. Must run before afterAll's
 *  cleanupAll cascades the workflow delete: a "running" execution hung on
 *  a specific node and a missing execution row (webhook accepted, nothing
 *  dispatched) are different bugs, and both are invisible afterwards. */
async function describeExecutionState(workflowId: string): Promise<string> {
  const client = postgres(getDatabaseUrl(), { max: 1 });
  try {
    const executions = await client`
      SELECT id, status, left(coalesce(error, ''), 200) AS error
      FROM workflow_executions WHERE workflow_id = ${workflowId}
      ORDER BY started_at DESC LIMIT 5`;
    if (executions.length === 0) {
      return "diagnosis: no workflow_executions row for this workflow - webhook accepted but nothing was dispatched";
    }
    const steps = await client`
      SELECT node_id, node_name, node_type, status, left(coalesce(error, ''), 200) AS error, started_at, completed_at
      FROM workflow_execution_logs WHERE execution_id = ${executions[0].id as string}
      ORDER BY started_at ASC LIMIT 20`;
    const execSummary = executions
      .map(
        (e) => `execution ${e.id}: ${e.status}${e.error ? ` (${e.error})` : ""}`
      )
      .join("; ");
    // node_id disambiguates steps that share a display name (e.g. a setup
    // workflow with several protocol steps of the same action).
    const stepSummary = steps
      .map(
        (s) =>
          `  step ${s.node_id} ${s.node_name} [${s.node_type}]: ${s.status}${s.error ? ` (${s.error})` : ""} started=${s.started_at}${s.completed_at ? ` completed=${s.completed_at}` : " (never completed)"}`
      )
      .join("\n");
    return `diagnosis: ${execSummary}\n${stepSummary || "  (no step logs recorded)"}`;
  } catch (err) {
    return `diagnosis unavailable: ${(err as Error).message}`;
  } finally {
    await client.end();
  }
}

export async function cleanupAll(ctx: SharedCtx): Promise<void> {
  for (const id of ctx.workflowIds) {
    try {
      await deleteTestWorkflow(id);
    } catch (err) {
      console.warn(
        `cleanup: deleteTestWorkflow(${id}) failed: ${(err as Error).message}`
      );
    }
  }
  ctx.workflowIds = [];
  if (ctx.apiKey) {
    try {
      await deleteApiKey(ctx.apiKey);
    } catch (err) {
      console.warn(`cleanup: deleteApiKey failed: ${(err as Error).message}`);
    }
    ctx.apiKey = undefined;
  }
  ctx.walletAddress = undefined;
}
