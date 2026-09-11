import { Counter, Gauge, Registry } from "prom-client";
import type { ConnectionHealth } from "../src/ingest/solana-connection";

/**
 * Prometheus metrics for the Solana tracker.
 *
 * Why this exists at all: `/healthz` used to back the Kubernetes liveness
 * probe and 503'd whenever any single chain was degraded, so a silent chain
 * restarted the pod and the namespace-wide "KeeperHub Pod Restarts" alert
 * paged as a side effect. That was the only signal. Moving liveness off chain
 * state removes it, so these metrics are the deliberate replacement - not a
 * nice-to-have.
 *
 * The series set is a pure function of current health. Every scrape rebuilds
 * it through syncMetrics(), and any chain missing from the current health is
 * dropped. An earlier version removed a series only when the reconciler
 * dropped a chain from its registry, and three paths slipped past that: a
 * chain that failed to start and later left discovery, a composite chain whose
 * worst member changed, and a queued chain labelled with a guessed source.
 * Each left a series climbing forever with the alert firing on it. Rebuilding
 * on every scrape closes that whole class instead of each case.
 *
 * Deliberate divergences from the block dispatcher's metrics:
 *
 *  1. `seconds_since_last_slot` falls back to "seconds since the chain's
 *     source came up" when no slot has ever arrived, rather than reporting 0.
 *     The devnet route that broke on 2026-09-09 delivered nothing at all, so a
 *     `null -> 0` rule would never have fired.
 *  2. A chain still queued behind others on a cold start emits no
 *     `seconds_since_last_slot` yet. `/livez` gives a cold start a grace
 *     window, and the alert should not give it less.
 *  3. Series carry the numeric chain id, not the chain name, so the page and
 *     the tracker's own log lines agree.
 */

const PREFIX = "keeperhub_solana_tracker";

/**
 * Deliberately not `collectDefaultMetrics()` - same omission as the block
 * dispatcher. Node process metrics for this pod already arrive via cAdvisor.
 */
export const registry = new Registry();

export interface ChainHealthEntry {
  health: ConnectionHealth;
  isTestnet: boolean;
}

interface ChainSnapshot {
  chain: string;
  testnet: string;
  /** When the chain's source first came up; null while it is still queued. */
  watchingSince: number | null;
  lastSlotAt: number | null;
  subscribedAt: number | null;
}

/**
 * Keyed on chain id alone. A composite chain runs two subscriptions but
 * reports one health, taken from whichever member ranks worst, so its `source`
 * changes over time. Keying on it stranded the previous entry. The source is
 * still on `/healthz` for diagnosis.
 */
const snapshots = new Map<string, ChainSnapshot>();

/** Last in-process counter total seen, per chain and per counter. */
const counterBaselines = new Map<string, Map<string, number>>();

const LABEL_NAMES = ["chain", "testnet"] as const;
type ChainLabels = Record<(typeof LABEL_NAMES)[number], string>;

function labelsOf(snap: ChainSnapshot): ChainLabels {
  return { chain: snap.chain, testnet: snap.testnet };
}

/**
 * THE alert signal. Computed at scrape time so it can never go stale between
 * syncs - the same trick the block dispatcher uses for its
 * seconds_since_last_block gauge.
 */
const secondsSinceLastSlot = new Gauge({
  name: `${PREFIX}_seconds_since_last_slot`,
  help: "Seconds since this chain's slot subscription last delivered a notification, or since its source came up if none ever has; absent while the chain is still queued on a cold start",
  labelNames: LABEL_NAMES,
  registers: [registry],
  collect() {
    this.reset();
    const now = Date.now();
    for (const snap of snapshots.values()) {
      if (snap.watchingSince === null) {
        continue;
      }
      const since = snap.lastSlotAt ?? snap.watchingSince;
      this.set(labelsOf(snap), (now - since) / 1000);
    }
  },
});

const subscriptionAgeSeconds = new Gauge({
  name: `${PREFIX}_subscription_age_seconds`,
  help: "Seconds since the current slot subscription was established; resets on every resubscribe, so an abnormally low value means churn",
  labelNames: LABEL_NAMES,
  registers: [registry],
  collect() {
    this.reset();
    const now = Date.now();
    for (const snap of snapshots.values()) {
      if (snap.subscribedAt !== null) {
        this.set(labelsOf(snap), (now - snap.subscribedAt) / 1000);
      }
    }
  },
});

const isConnected = new Gauge({
  name: `${PREFIX}_is_connected`,
  help: "1 when a real slot arrived inside the staleness window, not merely when a subscription was requested",
  labelNames: LABEL_NAMES,
  registers: [registry],
});

const isReconnecting = new Gauge({
  name: `${PREFIX}_is_reconnecting`,
  help: "1 while a reconnect is in flight",
  labelNames: LABEL_NAMES,
  registers: [registry],
});

const currentEndpointIndex = new Gauge({
  name: `${PREFIX}_current_endpoint_index`,
  help: "Index of the endpoint currently in use: 0 = primary, 1 = fallback",
  labelNames: LABEL_NAMES,
  registers: [registry],
});

const chainsExpected = new Gauge({
  name: `${PREFIX}_chains_expected`,
  help: "Chains discovery says should be ingesting; legitimately 0 when no Solana workflows exist",
  registers: [registry],
});

const chainsRunning = new Gauge({
  name: `${PREFIX}_chains_running`,
  help: "Chains with a running ingestor; expected minus running is the chains that are queued or failed to start",
  registers: [registry],
});

const reconnectsTotal = new Counter({
  name: `${PREFIX}_reconnects_total`,
  help: "Slot-subscription rebuilds triggered by the staleness watchdog; a healthy chain produces none",
  labelNames: LABEL_NAMES,
  registers: [registry],
});

const abandonedSubscriptionsTotal = new Counter({
  name: `${PREFIX}_abandoned_subscriptions_total`,
  help: "Unsubscribe calls that did not settle inside the timeout and were abandoned; the direct signature of the PD #33473 wedge",
  labelNames: LABEL_NAMES,
  registers: [registry],
});

/**
 * Turn an in-process total into a counter increment.
 *
 * A total below the last one seen means the source was rebuilt and began
 * counting from zero again. Counting the new total from scratch keeps the
 * counter moving. The earlier version swallowed every increment until the new
 * total overtook the old one, which hid exactly the counter meant to show a
 * repeat of the 2026-09-09 wedge.
 */
function advanceCounter(
  name: string,
  counter: Counter<(typeof LABEL_NAMES)[number]>,
  labels: ChainLabels,
  total: number,
): void {
  let baselines = counterBaselines.get(labels.chain);
  if (!baselines) {
    baselines = new Map();
    counterBaselines.set(labels.chain, baselines);
  }
  const seen = baselines.get(name);
  const delta = seen === undefined || total < seen ? total : total - seen;
  if (delta > 0) {
    counter.inc(labels, delta);
  }
  baselines.set(name, total);
}

/**
 * Rebuild every series from the current health. Called at scrape time, so
 * nothing in the ingest path has to know metrics exist.
 *
 * Endpoint URLs are never a label: chain-config carries the provider key in
 * the URL path, and a label value is durable in the TSDB and echoed into
 * PagerDuty and Discord. `current_endpoint_index` answers the only operational
 * question - primary or fallback - without the credential.
 */
export function syncMetrics(
  entries: ChainHealthEntry[],
  counts: { running: number; expected: number },
): void {
  const now = Date.now();
  const present = new Set<string>();
  isConnected.reset();
  isReconnecting.reset();
  currentEndpointIndex.reset();

  for (const { health, isTestnet } of entries) {
    const chain = String(health.chainId);
    present.add(chain);
    const existing = snapshots.get(chain);
    const snap: ChainSnapshot = {
      chain,
      testnet: isTestnet ? "true" : "false",
      watchingSince:
        existing?.watchingSince ?? (health.state === "idle" ? null : now),
      lastSlotAt: health.lastSlotAt,
      subscribedAt: health.subscribedAt,
    };
    snapshots.set(chain, snap);

    const labels = labelsOf(snap);
    isConnected.set(labels, health.connected ? 1 : 0);
    isReconnecting.set(labels, health.reconnecting ? 1 : 0);
    currentEndpointIndex.set(labels, health.endpointIndex);
    advanceCounter("reconnects", reconnectsTotal, labels, health.reconnects);
    advanceCounter(
      "abandoned",
      abandonedSubscriptionsTotal,
      labels,
      health.abandonedSubscriptions,
    );
  }

  for (const chain of [...snapshots.keys()]) {
    if (!present.has(chain)) {
      forget(chain);
    }
  }

  chainsExpected.set(counts.expected);
  chainsRunning.set(counts.running);
}

function forget(chain: string): void {
  snapshots.delete(chain);
  counterBaselines.delete(chain);
}

/**
 * Drop a chain's state right away, without waiting for the next scrape to
 * notice it is gone. Called when the reconciler drops or restarts a chain, so
 * a rebuilt source starts its silence clock and counter baselines fresh.
 *
 * Counter series are kept: their history is more useful than an empty series,
 * and a counter cannot pin a threshold alert the way a stuck gauge can.
 */
export function forgetChain(chainId: number): void {
  forget(String(chainId));
}

/** Test seam. Never called in production. */
export function resetMetrics(): void {
  snapshots.clear();
  counterBaselines.clear();
  registry.resetMetrics();
}
