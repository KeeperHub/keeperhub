/**
 * Operator script: reconcile Turnkey baseline policies for one or all
 * agentic-wallet sub-orgs.
 *
 * Why: when BASELINE_POLICIES changes (e.g. ERC-8004 update added two new
 * policies and modified the outbound allowlist condition), already-provisioned
 * sub-orgs lag behind. This script brings them up to date without
 * re-provisioning the wallet (which would invalidate the wallet address).
 *
 * Usage:
 *   pnpm tsx scripts/upgrade-agentic-wallet-policies.ts [--sub-org=<id>] [--dry-run]
 *
 * Without --sub-org, iterates EVERY row in agentic_wallets. Use --dry-run to
 * preview the actions without mutating Turnkey state.
 *
 * Required env: TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY,
 * TURNKEY_ORGANIZATION_ID, DATABASE_URL.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agenticWallets } from "@/lib/db/schema";
import { reconcileBaselinePolicies } from "@/lib/agentic-wallet/policy-migration";
import { getTurnkeyClientForOrg } from "@/lib/turnkey/agentic-wallet";

type Args = {
  subOrgId: string | null;
  dryRun: boolean;
};

function parseArgs(): Args {
  const out: Args = { subOrgId: null, dryRun: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg.startsWith("--sub-org=")) {
      out.subOrgId = arg.slice("--sub-org=".length);
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }
  return out;
}

async function getTargetSubOrgs(filter: string | null): Promise<string[]> {
  if (filter) {
    const rows = await db
      .select({ subOrgId: agenticWallets.subOrgId })
      .from(agenticWallets)
      .where(eq(agenticWallets.subOrgId, filter));
    return rows.map((r) => r.subOrgId);
  }
  const rows = await db
    .select({ subOrgId: agenticWallets.subOrgId })
    .from(agenticWallets);
  return rows.map((r) => r.subOrgId);
}

async function reconcileOne(args: {
  subOrgId: string;
  dryRun: boolean;
}): Promise<void> {
  const { subOrgId, dryRun } = args;
  if (dryRun) {
    process.stdout.write(`[dry-run] would reconcile ${subOrgId}\n`);
    return;
  }
  const client = getTurnkeyClientForOrg(subOrgId).apiClient();
  const result = await reconcileBaselinePolicies({ client, subOrgId });
  for (const action of result.actions) {
    if (action.action === "noop") {
      process.stdout.write(`  ${subOrgId}: noop ${action.policyName}\n`);
    } else if (action.action === "create") {
      process.stdout.write(
        `  ${subOrgId}: create ${action.policyName} -> ${action.policyId}\n`,
      );
    } else {
      process.stdout.write(
        `  ${subOrgId}: replace ${action.policyName} ${action.oldPolicyId} -> ${action.newPolicyId}\n`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const targets = await getTargetSubOrgs(args.subOrgId);
  if (targets.length === 0) {
    process.stdout.write("No matching sub-orgs found\n");
    return;
  }
  process.stdout.write(
    `Reconciling ${targets.length} sub-org(s)${args.dryRun ? " (dry-run)" : ""}\n`,
  );
  for (const subOrgId of targets) {
    try {
      await reconcileOne({ subOrgId, dryRun: args.dryRun });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  ${subOrgId}: FAILED ${message}\n`);
    }
  }
  process.stdout.write("Done\n");
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
