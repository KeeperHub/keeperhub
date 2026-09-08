/**
 * Reconcile a sub-org's Turnkey policies against the current BASELINE_POLICIES
 * snapshot.
 *
 * Existing wallets created before the ERC-8004 policy update have an OLDER
 * baseline (e.g. allowlist-outbound-contracts only allowing USDC). To enable
 * giveFeedback() signing on those wallets we must either: (a) re-provision
 * them (loses funds), or (b) reconcile their on-chain Turnkey policy set to
 * the new baseline. This module is path (b).
 *
 * Strategy:
 *   - Fetch current policies for the sub-org
 *   - For each BASELINE_POLICIES entry, compare condition+notes against the
 *     existing policy with the same name
 *     - absent  -> createPolicy
 *     - stale   -> deletePolicy + createPolicy (Turnkey policies are immutable
 *                  in their condition, so update == delete+recreate)
 *     - fresh   -> no-op
 *   - Best-effort consistency: if any create fails partway, throw -- the
 *     caller (lazy-migrate path or admin script) can retry safely.
 *
 * Idempotent. Safe to run repeatedly. Read-only when nothing has drifted.
 *
 * SECURITY NOTE: This function modifies sub-org policy state. Call sites:
 *   - scripts/upgrade-agentic-wallet-policies.ts (operator, one-shot)
 *   - lazy-migrate path on first feedback submission (server-only)
 * It MUST NOT be exposed via an HTTP endpoint without auth. Caller is
 * responsible for authentication; this module trusts its arguments.
 */
import type { Turnkey } from "@turnkey/sdk-server";
import { BASELINE_POLICIES, type BaselinePolicy } from "./policy";

type ApiClient = ReturnType<Turnkey["apiClient"]>;

type ListedPolicy = {
  policyId: string;
  policyName: string;
  effect: string;
  condition?: string;
  notes?: string;
};

export type ReconcileAction =
  | { action: "noop"; policyName: string }
  | { action: "create"; policyName: string; policyId: string }
  | {
      action: "replace";
      policyName: string;
      oldPolicyId: string;
      newPolicyId: string;
    };

export type ReconcileResult = {
  subOrgId: string;
  actions: ReconcileAction[];
};

/**
 * Compare a baseline definition against a listed policy to decide whether
 * the listed copy is up-to-date. Notes are intentionally NOT compared --
 * cosmetic edits to the notes string should not trigger a destructive
 * delete+create round-trip. Only `condition` and `effect` decide drift.
 */
function isStale(baseline: BaselinePolicy, listed: ListedPolicy): boolean {
  if (listed.effect !== baseline.effect) {
    return true;
  }
  if ((listed.condition ?? "") !== baseline.condition) {
    return true;
  }
  return false;
}

export async function reconcileBaselinePolicies(args: {
  client: ApiClient;
  subOrgId: string;
}): Promise<ReconcileResult> {
  const { client, subOrgId } = args;

  const listedRaw = (await client.getPolicies({
    organizationId: subOrgId,
  })) as { policies?: ListedPolicy[] };
  const byName = new Map<string, ListedPolicy>();
  for (const p of listedRaw.policies ?? []) {
    byName.set(p.policyName, p);
  }

  const actions: ReconcileAction[] = [];

  for (const baseline of BASELINE_POLICIES) {
    const existing = byName.get(baseline.policyName);
    if (!existing) {
      const created = (await client.createPolicy({
        organizationId: subOrgId,
        policyName: baseline.policyName,
        effect: baseline.effect,
        condition: baseline.condition,
        consensus: "true",
        notes: baseline.notes,
      })) as unknown as { policyId?: string };
      actions.push({
        action: "create",
        policyName: baseline.policyName,
        policyId: created.policyId ?? "",
      });
      continue;
    }
    if (!isStale(baseline, existing)) {
      actions.push({ action: "noop", policyName: baseline.policyName });
      continue;
    }
    // Replace (delete + create). Turnkey rejects duplicate policy names
    // ("policy label must be unique") on the v1 createPolicy API, so we
    // CANNOT create-before-delete. We accept a brief coverage gap between
    // delete and create. If create fails after delete succeeds, the caller
    // MUST retry -- the throw propagates out of this function so the
    // operator script surfaces it.
    await client.deletePolicy({
      organizationId: subOrgId,
      policyId: existing.policyId,
    });
    const created = (await client.createPolicy({
      organizationId: subOrgId,
      policyName: baseline.policyName,
      effect: baseline.effect,
      condition: baseline.condition,
      consensus: "true",
      notes: baseline.notes,
    })) as unknown as { policyId?: string };
    actions.push({
      action: "replace",
      policyName: baseline.policyName,
      oldPolicyId: existing.policyId,
      newPolicyId: created.policyId ?? "",
    });
  }

  return { subOrgId, actions };
}
