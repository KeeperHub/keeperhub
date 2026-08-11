/**
 * Kubernetes-native leader election for the dispatchers.
 *
 * Both dispatchers run 2 replicas for availability, but only one may dispatch
 * to SQS at a time: two active replicas would double-enqueue and every
 * scheduled/block-triggered workflow would run twice (the queue is a standard,
 * non-FIFO SQS queue with no dedup). Election picks a single leader; the
 * standby idles and takes over when the leader's node/pod goes away.
 *
 * The mechanism is the coordination.k8s.io/v1 Lease object - the same primitive
 * kube-controller-manager and controller-runtime operators use. No external
 * store (etcd/Zookeeper/Redis) is added: the cluster's API server already
 * backs it. The renew/acquire loop mirrors client-go's leaderelection:
 *
 *   - The leader renews the Lease every retryPeriod.
 *   - If it cannot renew within renewDeadline it relinquishes leadership and
 *     stops dispatching. Because renewDeadline < leaseDuration, a standby
 *     cannot acquire the Lease until after the old leader has already stopped,
 *     leaving a gap where nobody dispatches rather than an overlap where two do.
 *
 * The renew gap plus the dispatch-idempotency key on the phantom-execution row
 * together guarantee no duplicate dispatch across failover and rolling restart.
 */

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import {
  ApiException,
  CoordinationV1Api,
  KubeConfig,
  type V1Lease,
  V1MicroTime,
} from "@kubernetes/client-node";

const NAMESPACE_FILE =
  "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

export interface LeaderElectionConfig {
  /** Lease object name. Each dispatcher uses its own so they elect separately. */
  leaseName: string;
  /** Namespace of the Lease. Resolved from the pod's service account if omitted. */
  namespace?: string;
  /** Unique per-pod identity. Defaults to the pod hostname (the pod name in k8s). */
  holderIdentity?: string;
  /** Seconds a Lease is valid without renewal before a standby may take over. */
  leaseDurationSeconds?: number;
  /** Seconds the leader keeps trying to renew before relinquishing leadership. */
  renewDeadlineSeconds?: number;
  /** Seconds between acquire/renew attempts. */
  retryPeriodSeconds?: number;
  /** Called once when this instance becomes the leader. */
  onStartedLeading: () => void | Promise<void>;
  /** Called when this instance loses leadership (renew failed, or on shutdown). */
  onStoppedLeading: () => void | Promise<void>;
}

/** Handle returned by {@link runWithLeaderElection}. */
export interface LeaderElectionHandle {
  /** True while this instance holds the Lease and may dispatch. */
  isLeader(): boolean;
  /** Stop the loop and best-effort release the Lease so a standby takes over. */
  stop(): Promise<void>;
}

const DEFAULT_LEASE_DURATION_SECONDS = 15;
const DEFAULT_RENEW_DEADLINE_SECONDS = 10;
const DEFAULT_RETRY_PERIOD_SECONDS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiErrorCode(error: unknown): number | undefined {
  return error instanceof ApiException ? error.code : undefined;
}

/**
 * Resolve the namespace to create the Lease in. Fails closed rather than
 * defaulting to "default": a Lease in the wrong namespace would silently split
 * the election (two leaders, one per namespace) and reintroduce double-dispatch.
 */
function resolveNamespace(explicit?: string): string {
  const fromArg = explicit ?? process.env.LEASE_NAMESPACE;
  if (fromArg) {
    return fromArg;
  }
  try {
    const fromFile = readFileSync(NAMESPACE_FILE, "utf8").trim();
    if (fromFile) {
      return fromFile;
    }
  } catch {
    // fall through to the explicit failure below
  }
  throw new Error(
    "Leader election namespace could not be resolved (no LEASE_NAMESPACE and no in-cluster service account namespace file)",
  );
}

export class LeaderElector implements LeaderElectionHandle {
  private readonly api: CoordinationV1Api;
  private readonly namespace: string;
  private readonly identity: string;
  private readonly leaseName: string;
  private readonly leaseDurationSeconds: number;
  private readonly renewDeadlineMs: number;
  private readonly retryPeriodMs: number;
  private readonly onStartedLeading: () => void | Promise<void>;
  private readonly onStoppedLeading: () => void | Promise<void>;

  private leading = false;
  private stopped = false;
  /** Wall-clock ms of the last successful acquire/renew. */
  private lastRenewMs = 0;

  constructor(config: LeaderElectionConfig) {
    const leaseDuration =
      config.leaseDurationSeconds ?? DEFAULT_LEASE_DURATION_SECONDS;
    const renewDeadline =
      config.renewDeadlineSeconds ?? DEFAULT_RENEW_DEADLINE_SECONDS;
    const retryPeriod =
      config.retryPeriodSeconds ?? DEFAULT_RETRY_PERIOD_SECONDS;

    if (renewDeadline >= leaseDuration) {
      throw new Error(
        `renewDeadlineSeconds (${renewDeadline}) must be less than leaseDurationSeconds (${leaseDuration}); otherwise a standby could acquire the Lease before the old leader relinquishes it`,
      );
    }
    if (retryPeriod >= renewDeadline) {
      throw new Error(
        `retryPeriodSeconds (${retryPeriod}) must be less than renewDeadlineSeconds (${renewDeadline})`,
      );
    }

    const kc = new KubeConfig();
    kc.loadFromDefault();
    this.api = kc.makeApiClient(CoordinationV1Api);
    this.namespace = resolveNamespace(config.namespace);
    this.identity = config.holderIdentity ?? hostname();
    this.leaseName = config.leaseName;
    this.leaseDurationSeconds = leaseDuration;
    this.renewDeadlineMs = renewDeadline * 1000;
    this.retryPeriodMs = retryPeriod * 1000;
    this.onStartedLeading = config.onStartedLeading;
    this.onStoppedLeading = config.onStoppedLeading;
  }

  isLeader(): boolean {
    return this.leading;
  }

  /** Runs the acquire/renew loop until {@link stop} is called. */
  async run(): Promise<void> {
    console.log(
      `[LeaderElection] Starting for lease "${this.leaseName}" in namespace "${this.namespace}" as "${this.identity}"`,
    );
    while (!this.stopped) {
      const acquired = await this.tryAcquireOrRenew();
      if (acquired) {
        this.lastRenewMs = Date.now();
        if (!this.leading) {
          this.leading = true;
          console.log(
            `[LeaderElection] Acquired leadership of "${this.leaseName}"`,
          );
          await this.safelyInvoke(this.onStartedLeading, "onStartedLeading");
        }
      } else if (this.leading) {
        // Keep leadership through transient failures until renewDeadline lapses.
        // Past that a standby may take over, so we must stop first.
        if (Date.now() - this.lastRenewMs > this.renewDeadlineMs) {
          this.leading = false;
          console.warn(
            `[LeaderElection] Failed to renew "${this.leaseName}" within renewDeadline; relinquishing leadership`,
          );
          await this.safelyInvoke(this.onStoppedLeading, "onStoppedLeading");
        }
      }
      await sleep(this.retryPeriodMs);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.leading) {
      this.leading = false;
      await this.releaseLease();
      await this.safelyInvoke(this.onStoppedLeading, "onStoppedLeading");
    }
  }

  /**
   * Attempt to acquire (or renew) the Lease. Returns true if this instance
   * holds it after the call. Contention and transient API errors return false.
   */
  private async tryAcquireOrRenew(): Promise<boolean> {
    try {
      const lease = await this.readLease();
      const now = new V1MicroTime();

      if (!lease) {
        await this.api.createNamespacedLease({
          namespace: this.namespace,
          body: {
            metadata: { name: this.leaseName, namespace: this.namespace },
            spec: {
              holderIdentity: this.identity,
              leaseDurationSeconds: this.leaseDurationSeconds,
              acquireTime: now,
              renewTime: now,
              leaseTransitions: 0,
            },
          },
        });
        return true;
      }

      const spec = lease.spec ?? {};
      const heldByUs = spec.holderIdentity === this.identity;
      const renewMs = spec.renewTime ? new Date(spec.renewTime).getTime() : 0;
      const durationSeconds =
        spec.leaseDurationSeconds ?? this.leaseDurationSeconds;
      const expired = Date.now() - renewMs > durationSeconds * 1000;

      if (!heldByUs && !expired) {
        // Someone else holds a still-valid Lease.
        return false;
      }

      lease.spec = {
        ...spec,
        holderIdentity: this.identity,
        leaseDurationSeconds: this.leaseDurationSeconds,
        renewTime: now,
        acquireTime: heldByUs ? (spec.acquireTime ?? now) : now,
        leaseTransitions: heldByUs
          ? (spec.leaseTransitions ?? 0)
          : (spec.leaseTransitions ?? 0) + 1,
      };

      // resourceVersion on the read object makes this a compare-and-swap: a
      // racing holder that wrote first bumps the version and this 409s.
      await this.api.replaceNamespacedLease({
        name: this.leaseName,
        namespace: this.namespace,
        body: lease,
      });
      return true;
    } catch (error) {
      const code = apiErrorCode(error);
      if (code === 409) {
        // Lost the compare-and-swap race to another candidate.
        return false;
      }
      console.warn(
        `[LeaderElection] Acquire/renew attempt for "${this.leaseName}" failed:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  private async readLease(): Promise<V1Lease | null> {
    try {
      return await this.api.readNamespacedLease({
        name: this.leaseName,
        namespace: this.namespace,
      });
    } catch (error) {
      if (apiErrorCode(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Best-effort release on graceful shutdown: clear the holder so a standby
   * acquires immediately instead of waiting out the full leaseDuration.
   */
  private async releaseLease(): Promise<void> {
    try {
      const lease = await this.readLease();
      if (!lease || lease.spec?.holderIdentity !== this.identity) {
        return;
      }
      lease.spec = {
        ...lease.spec,
        holderIdentity: undefined,
        renewTime: undefined,
        acquireTime: undefined,
      };
      await this.api.replaceNamespacedLease({
        name: this.leaseName,
        namespace: this.namespace,
        body: lease,
      });
      console.log(`[LeaderElection] Released lease "${this.leaseName}"`);
    } catch (error) {
      console.warn(
        `[LeaderElection] Failed to release lease "${this.leaseName}" (it will expire naturally):`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async safelyInvoke(
    fn: () => void | Promise<void>,
    label: string,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      console.error(
        `[LeaderElection] ${label} callback threw:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/**
 * Run the given callbacks under leader election when it is enabled, otherwise
 * run as the sole leader.
 *
 * Election is opt-in via LEADER_ELECTION_ENABLED=true so local dev and the
 * integration harness (no cluster, no Lease API) keep running as a single
 * dispatcher. In staging/prod the umbrella values set the flag and inject the
 * lease name; the pod's service account provides namespace and RBAC.
 */
export function runWithLeaderElection(
  config: LeaderElectionConfig,
): LeaderElectionHandle {
  const enabled = process.env.LEADER_ELECTION_ENABLED === "true";

  if (!enabled) {
    console.log(
      "[LeaderElection] Disabled (LEADER_ELECTION_ENABLED != true); running as sole leader",
    );
    let leading = true;
    void Promise.resolve(config.onStartedLeading()).catch((error: unknown) => {
      console.error(
        "[LeaderElection] onStartedLeading callback threw:",
        error instanceof Error ? error.message : error,
      );
    });
    return {
      isLeader: () => leading,
      stop: async () => {
        if (leading) {
          leading = false;
          await Promise.resolve(config.onStoppedLeading()).catch(() => {
            // shutdown path; nothing else to do
          });
        }
      },
    };
  }

  const elector = new LeaderElector(config);
  // Run the loop detached; the caller drives lifecycle via the handle and its
  // onStartedLeading/onStoppedLeading callbacks.
  void elector.run().catch((error: unknown) => {
    console.error(
      "[LeaderElection] Election loop crashed:",
      error instanceof Error ? error.message : error,
    );
    // Exit so the orchestrator restarts us rather than running leaderless.
    process.exit(1);
  });
  return elector;
}
