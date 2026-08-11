/**
 * Initial credit grant for newly-provisioned agentic wallets.
 *
 * ONBOARD-03: $0.50 off-chain KeeperHub credit written to the
 * agentic_wallet_credits ledger at provision time. Phase 34 tooling
 * (fund / balance) reads this ledger.
 *
 * UNIQUE `(sub_org_id, allocation_reason)` in the schema guards
 * T-33-07 (double-grant race): a concurrent /provision retry for the
 * same sub-org re-throws with a clear UNIQUE-violation message.
 *
 * Phase 37 Wave 4 Task 19: the wallet + credit inserts now run inside a
 * single `db.transaction` in provision.ts (option (b) from the plan),
 * which inlines the insert against the transaction handle. This helper
 * and the exported constant remain available for ad-hoc re-grants or
 * future callers that don't need transactional coupling.
 */
import { db } from "@/lib/db";
import { agenticWalletCredits } from "@/lib/db/schema";

export const ONBOARD_INITIAL_CREDIT_CENTS = 50;

export async function grantInitialCredit(subOrgId: string): Promise<void> {
  await db.insert(agenticWalletCredits).values({
    subOrgId,
    amountUsdcCents: ONBOARD_INITIAL_CREDIT_CENTS,
    allocationReason: "onboard_initial",
  });
}
