/**
 * Safe wallet metrics instrumentation (KEEP-301 wave 2).
 *
 * Covers the hot-path Safe operations:
 *   - safe.deploy.*        CREATE2 proxy deploy via SafeProxyFactory
 *   - safe.role_install.*  Zodiac Roles modifier proxy + initial config
 *   - safe.tx.*            safe.execTransaction owner-signed writes
 *                          and rolesModifier.execTransactionWithRole writes
 *   - safe.withdraw.*      user-initiated withdraw clicks routed via
 *                          executeContractCallAsSafe / executeNativeTransferAsSafe
 *
 * Each helper returns a finish() callback so callers can record both the
 * outcome counter and the duration histogram in one shot.
 */

import type { SignerModeKind } from "@/lib/safe/signer-resolver";
import { createTimer, getMetricsCollector } from "../index";
import { MetricNames } from "../types";

/** Two-bucket call route: owner-signed Safe vs Zodiac Roles modifier. */
export type SafeTxRoute = "exec" | "role";

/** Inner-call shape so dashboards can split native vs ERC-20 vs arbitrary. */
export type SafeTxKind = "native" | "erc20" | "contract";

export type SafeTxOptions = {
  chainId: number;
  route: SafeTxRoute;
  kind: SafeTxKind;
};

function chainLabel(chainId: number): string {
  return String(chainId);
}

/**
 * Wrap a Safe-routed transaction so we increment a counter once + record
 * its latency histogram on completion. Returns a finisher that the caller
 * invokes with the resolved outcome.
 */
export function startSafeTxMetrics(
  options: SafeTxOptions
): (outcome: "success" | "failure" | "nonce-conflict") => void {
  const metrics = getMetricsCollector();
  const timer = createTimer();
  const baseLabels = {
    chain_id: chainLabel(options.chainId),
    route: options.route,
    kind: options.kind,
  };

  return (outcome) => {
    const labels = { ...baseLabels, outcome };
    metrics.incrementCounter(MetricNames.SAFE_TX_TOTAL, labels);
    metrics.recordLatency(MetricNames.SAFE_TX_DURATION, timer(), labels);
  };
}

/**
 * Deploy timer for the SafeProxyFactory CREATE2 path. Increments a counter
 * + histogram. Use `outcome: "already_deployed"` for the idempotent
 * short-circuit, "success" when the tx confirms, "failure" otherwise.
 */
export function startSafeDeployMetrics(
  chainId: number
): (outcome: "success" | "already_deployed" | "failure") => void {
  const metrics = getMetricsCollector();
  const timer = createTimer();
  const baseLabels = { chain_id: chainLabel(chainId) };

  return (outcome) => {
    const labels = { ...baseLabels, outcome };
    metrics.incrementCounter(MetricNames.SAFE_DEPLOY_TOTAL, labels);
    metrics.recordLatency(MetricNames.SAFE_DEPLOY_DURATION, timer(), labels);
  };
}

/**
 * Roles modifier install timer (proxy deploy + initial protocol/allowance
 * config). Increments a counter + histogram on completion.
 */
export function startSafeRoleInstallMetrics(
  chainId: number
): (outcome: "success" | "failure") => void {
  const metrics = getMetricsCollector();
  const timer = createTimer();
  const baseLabels = { chain_id: chainLabel(chainId) };

  return (outcome) => {
    const labels = { ...baseLabels, outcome };
    metrics.incrementCounter(MetricNames.SAFE_ROLE_INSTALL_TOTAL, labels);
    metrics.recordLatency(
      MetricNames.SAFE_ROLE_INSTALL_DURATION,
      timer(),
      labels
    );
  };
}

/**
 * Withdraw-specific counter. Bumps a separate `safe.withdraw.total` so
 * the withdraw-from-Safe surface can be alerted on independently from
 * workflow-driven Safe writes (both share `safe.tx.*` underneath).
 */
export function recordSafeWithdraw(options: {
  chainId: number;
  kind: SafeTxKind;
  outcome: "success" | "failure";
}): void {
  const metrics = getMetricsCollector();
  metrics.incrementCounter(MetricNames.SAFE_WITHDRAW_TOTAL, {
    chain_id: chainLabel(options.chainId),
    kind: options.kind,
    outcome: options.outcome,
  });
}

/**
 * Signer-mode distribution counter (KEEP-568). Emitted once per
 * `resolveSignerMode` call so dashboards can answer "what fraction of org
 * writes are policy-gated (`safe-role`) vs unscoped (`safe`) vs EOA
 * (`eoa`)?" The per-tx `safe.tx.*` counter only sees the two Safe
 * branches; this resolver-level counter adds the EOA branch and lets
 * product/security stakeholders track Safe adoption over time.
 */
export function recordSignerMode(options: {
  kind: SignerModeKind;
  chainId: number;
}): void {
  const metrics = getMetricsCollector();
  metrics.incrementCounter(MetricNames.SIGNER_MODE_TOTAL, {
    kind: options.kind,
    chain_id: chainLabel(options.chainId),
  });
}

/**
 * Probe-swallow counter (KEEP-567). Fires when
 * `probeRolesModifierFromChain` hits both-RPC failure and the resolver
 * silently downgrades to unscoped `safe` mode. Pair with
 * `signer_mode.total{kind=safe}` to see how much of the safe-routed
 * surface bypassed policy enforcement during an RPC outage window; the
 * design call (hard-fail vs degrade-after-N vs keep silent) lives in
 * KEEP-567 and shouldn't be made without this measurement.
 */
export function recordSignerProbeFailure(options: { chainId: number }): void {
  const metrics = getMetricsCollector();
  metrics.incrementCounter(MetricNames.SIGNER_PROBE_FAILURE, {
    chain_id: chainLabel(options.chainId),
  });
}
