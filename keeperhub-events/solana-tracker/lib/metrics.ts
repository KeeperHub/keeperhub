import { Counter, Gauge, Registry } from "prom-client";
import type {
  ConnectionHealth,
  ConnectionSource,
} from "../src/ingest/solana-connection";

/**
 * Prometheus metrics for the Solana tracker.
 *
 * Why this exists at all: `/healthz` used to back the Kubernetes
 * liveness probe and 503'd whenever any single chain was degraded, so a silent
 * chain restarted the pod and the namespace-wide "KeeperHub Pod Restarts" alert
 * paged as a side effect. That was the only signal. Moving liveness off chain
 * state removes it, so these metrics are the deliberate replacement - not a
 * nice-to-have.
 *
 * Shape mirrors `keeperhub-scheduler/lib/metrics.ts`: one process-wide registry
 * that deliberately excludes Node's default process metrics, per-chain gauges,
 * and a `forgetChain` so a removed chain stops reporting instead of freezing at
 * its last value and pinning an alert open forever.
 *
 * Two deliberate divergences from the block dispatcher, both learned from
 * PD #33473:
 *
 *  1. `seconds_since_last_slot` falls back to "seconds since we started
 *     watching" when no slot has ever arrived, rather than reporting 0. The
 *     devnet route that broke delivered *nothing*, so a `null -> 0` rule would
 *     have read 0 forever and the alert would never have fired.
 *  2. Series are labelled with the numeric chain id, not the chain name. The
 *     block dispatcher uses `config.chain.name`; here every log line and
 *     `ConnectionHealth` field is numeric, so the page and the logs agree, and
 *     a rename in the chains table cannot orphan a firing alert.
 */

const PREFIX = "keeperhub_solana_tracker";

/**
 * Deliberately not `collectDefaultMetrics()` - same omission as the block
 * dispatcher. Node process metrics for this pod already arrive via cAdvisor.
 */
export const registry = new Registry();

interface ChainSnapshot {
  chain: string;
  source: ConnectionSource;
  testnet: string;
  /** When this chain/source pair was first registered, in ms. */
  watchingSince: number;
  lastSlotAt: number | null;
  subscribedAt: number | null;
}

/**
 * Keyed `${chain}|${source}` because a composite chain runs a SignaturesSource
 * and a GetBlockSource side by side, each with its own independent subscription
 * (see source-factory.ts). Keying on chain alone would make the two collide and
 * silently report whichever wrote last.
 */
const snapshots = new Map<string, ChainSnapshot>();

const key = (chain: string, source: ConnectionSource): string =>
  `${chain}|${source}`;

const CHAIN_LABELS = ["chain", "source", "testnet"] as const;

/**
 * THE alert signal. Computed at scrape time so it can never go stale between
 * reconcile passes - the same trick the block dispatcher uses for its
 * seconds_since_last_block gauge.
 */
const secondsSinceLastSlot = new Gauge({
  name: `${PREFIX}_seconds_since_last_slot`,
  help: "Seconds since this chain's slot subscription last delivered a notification, or since the chain was registered if none ever has",
  labelNames: CHAIN_LABELS,
  registers: [registry],
  collect() {
    const now = Date.now();
    for (const snap of snapshots.values()) {
      const since = snap.lastSlotAt ?? snap.watchingSince;
      this.set(
        { chain: snap.chain, source: snap.source, testnet: snap.testnet },
        (now - since) / 1000,
      );
    }
  },
});

const subscriptionAgeSeconds = new Gauge({
  name: `${PREFIX}_subscription_age_seconds`,
  help: "Seconds since the current slot subscription was established; resets on every resubscribe, so an abnormally low value means churn",
  labelNames: CHAIN_LABELS,
  registers: [registry],
  collect() {
    const now = Date.now();
    for (const snap of snapshots.values()) {
      this.set(
        { chain: snap.chain, source: snap.source, testnet: snap.testnet },
        snap.subscribedAt === null ? 0 : (now - snap.subscribedAt) / 1000,
      );
    }
  },
});

const isConnected = new Gauge({
  name: `${PREFIX}_is_connected`,
  help: "1 when the chain has a live slot stream (a real slot arrived inside the staleness window)",
  labelNames: CHAIN_LABELS,
  registers: [registry],
});

const isReconnecting = new Gauge({
  name: `${PREFIX}_is_reconnecting`,
  help: "1 while a reconnect is in flight",
  labelNames: CHAIN_LABELS,
  registers: [registry],
});

const currentEndpointIndex = new Gauge({
  name: `${PREFIX}_current_endpoint_index`,
  help: "Index of the endpoint currently in use: 0 = primary, 1 = fallback",
  labelNames: CHAIN_LABELS,
  registers: [registry],
});

const chainsTracked = new Gauge({
  name: `${PREFIX}_chains_tracked`,
  help: "Chain/source pairs the reconciler currently has a source for; legitimately 0 when no Solana workflows exist",
  registers: [registry],
  collect() {
    this.set(snapshots.size);
  },
});

const reconnectsTotal = new Counter({
  name: `${PREFIX}_reconnects_total`,
  help: "Slot-subscription rebuilds triggered by the staleness watchdog. A healthy chain produces none",
  labelNames: CHAIN_LABELS,
  registers: [registry],
});

const abandonedSubscriptionsTotal = new Counter({
  name: `${PREFIX}_abandoned_subscriptions_total`,
  help: "Unsubscribe calls that did not settle inside the timeout and were abandoned; the direct signature of the PD #33473 wedge",
  labelNames: CHAIN_LABELS,
  registers: [registry],
});

/**
 * Endpoint URLs are never a label. Chain-config carries the provider key in the
 * URL path, and a label value would be durable in the TSDB and echoed into
 * PagerDuty and Discord. `current_endpoint_index` answers the only operational
 * question - primary or fallback - without the credential. See
 * lib/utils/redact-url.ts.
 */
export function recordChainHealth(
  health: ConnectionHealth,
  isTestnet: boolean,
): void {
  const chain = String(health.chainId);
  const source = health.source;
  const testnet = isTestnet ? "true" : "false";
  const labels = { chain, source, testnet };

  const existing = snapshots.get(key(chain, source));
  snapshots.set(key(chain, source), {
    chain,
    source,
    testnet,
    watchingSince: existing?.watchingSince ?? Date.now(),
    lastSlotAt: health.lastSlotAt,
    subscribedAt: health.subscribedAt,
  });

  isConnected.set(labels, health.connected ? 1 : 0);
  isReconnecting.set(labels, health.reconnecting ? 1 : 0);
  currentEndpointIndex.set(labels, health.endpointIndex);

  // The connection keeps monotonic in-process totals; mirror the delta so a
  // process restart resets to 0, which is exactly what rate()/increase() want.
  bumpTo("reconnects", reconnectsTotal, labels, health.reconnects);
  bumpTo(
    "abandoned",
    abandonedSubscriptionsTotal,
    labels,
    health.abandonedSubscriptions,
  );
}

/** Counter deltas, since prom-client has no "set" for a Counter. */
const counterSeen = new Map<string, number>();
function bumpTo(
  name: string,
  counter: Counter<(typeof CHAIN_LABELS)[number]>,
  labels: Record<string, string>,
  total: number,
): void {
  const id = `${name}|${labels.chain}|${labels.source}`;
  const seen = counterSeen.get(id) ?? 0;
  if (total > seen) {
    counter.inc(labels, total - seen);
    counterSeen.set(id, total);
  }
}

/**
 * Drop every series for a chain. Called wherever the reconciler removes a chain
 * - removal, restart-on-config-change, and a failed start - because a frozen
 * `seconds_since_last_slot` would keep climbing and hold the alert open forever
 * on a chain nobody is watching any more.
 *
 * Counters are deliberately kept: their cumulative history is more useful than
 * an empty series, and they cannot pin a threshold alert the way a gauge can.
 */
export function forgetChain(chainId: number): void {
  const chain = String(chainId);
  for (const [mapKey, snap] of [...snapshots]) {
    if (snap.chain !== chain) {
      continue;
    }
    snapshots.delete(mapKey);
    const labels = {
      chain: snap.chain,
      source: snap.source,
      testnet: snap.testnet,
    };
    secondsSinceLastSlot.remove(labels);
    subscriptionAgeSeconds.remove(labels);
    isConnected.remove(labels);
    isReconnecting.remove(labels);
    currentEndpointIndex.remove(labels);
  }
}

/** Test seam. Never called in production. */
export function resetMetrics(): void {
  snapshots.clear();
  counterSeen.clear();
  registry.resetMetrics();
}
