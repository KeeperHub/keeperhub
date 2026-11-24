import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ErrorCategory,
  logSecurityEvent,
  logSystemError,
} from "../lib/logging";
import { getMetricsCollector } from "../lib/metrics";
import { MetricNames } from "../lib/metrics/types";
import {
  WARM_POOL_ACK_WINDOW_MS,
  WARM_POOL_DECISION_HEADER,
  WARM_POOL_EXECUTION_HEADER,
  WARM_POOL_TOKEN_HEADER,
  type WarmAckDecision,
  type WarmAssignment,
  warmAssignmentSchema,
} from "./warm-pool-protocol";

/**
 * Warm runner pool for workflows that opt into a low-latency start.
 *
 * A per-run Job spends most of its 10-20 s start-up on pod scheduling, image
 * start and runner bootstrap. The pool pays that cost ahead of time: it keeps
 * `size` runner Jobs that have booted and are waiting, each holding a long-poll
 * claim request open against this executor replica. Dispatching to the pool
 * answers one of those requests with the execution; the pod checks it against
 * the database and acknowledges, and runs it only once the executor confirms
 * that ack. With no ack in time, or a refusal, the executor starts a per-run
 * Job instead and the pod is told not to run it. An execution is never
 * started twice, and is lost only if the executor's confirmation itself is
 * dropped on the network after it was sent (the same exposure as a per-run
 * Job pod dying after it started).
 *
 * Isolation is the same as a per-run Job:
 *  - One execution per pod. A slot is removed from the pool the moment it is
 *    assigned, so its token can never claim a second run; the pod exits after
 *    its run like any runner.
 *  - Nothing about an organization or workflow reaches a pod before it is
 *    assigned. The Job carries only the platform-level env every runner has.
 *
 * Lifecycle of a slot:
 *  starting  Job created, pod has not polled yet.
 *  ready     pod holds an open claim request (only ready slots are assigned).
 *  between   pod polled before and is about to poll again.
 *  retired   past its idle lifetime; the next poll is answered 410 and the
 *            pod exits. A replacement is started `replaceLeadMs` before
 *            retirement so the pool does not dip.
 *  dead      no poll within the grace window (pod failed to start, crashed,
 *            evicted); dropped and its Job deleted.
 *
 * A token alone is not enough to claim: a poll is held only if it comes from
 * an address of the one running pod the token's Job owns (looked up through
 * the Kubernetes API by the Job's UID). Someone who read the token from the
 * Job spec cannot use it from anywhere else; trying it burns the slot.
 *
 * A claimed pod enforces the per-run deadline itself; as a backstop the
 * executor deletes the Job once that deadline plus a grace period has passed.
 * The backstop lives in this replica's memory, so it does not survive an
 * executor restart; the pod's own timer, which user code cannot block (Code
 * steps run in a child process), and the Job deadline still apply.
 *
 * Each executor replica owns its own pool. If a replica goes away, its pods
 * cannot reach it, give up after a short grace period and exit; a pod that
 * reaches a replica that does not know its token is told to exit (410).
 */

export type WarmJobParams = {
  token: string;
  claimUrl: string;
  maxIdleMs: number;
  preloadActionPrefixes: string;
};

export type WarmJobRef = { name: string; uid: string };

export type WarmPoolDeps = {
  createJob: (
    params: WarmJobParams
  ) => Promise<{ name?: string; uid?: string }>;
  deleteJob: (name: string) => Promise<void>;
  /**
   * Addresses of the one running pod the Job owns (matched by the Job's UID,
   * not by a label anyone could copy), or undefined while there is none.
   */
  lookupPodIps: (job: WarmJobRef) => Promise<string[] | undefined>;
  now?: () => number;
  random?: () => number;
  newToken?: () => string;
};

export type WarmPoolOptions = {
  size: number;
  idleTtlMs: number;
  longPollMs: number;
  claimUrl: string;
  preloadActionPrefixes: string;
  /** The per-run time limit a claimed pod gets (the Job deadline today). */
  runDeadlineMs: number;
  /**
   * Most claims one organization may make per minute. Defaults to half of
   * what the pool can serve in a minute, and never below 5 (every block on a
   * 12-second chain).
   */
  orgClaimsPerMinute?: number;
  /** How long to wait for a pod to acknowledge an offered execution. */
  ackTimeoutMs?: number;
  /** How long a new pod may take to send its first poll. */
  startupGraceMs?: number;
  /** Slack on top of the long-poll window before a quiet pod counts as dead. */
  pollGraceMs?: number;
  /** How long before retirement a replacement is started. */
  replaceLeadMs?: number;
  maintainIntervalMs?: number;
};

type Waiter = {
  res: ServerResponse;
  timer: NodeJS.Timeout;
};

type Slot = {
  token: string;
  jobName?: string;
  jobUid?: string;
  createdAt: number;
  retireAt: number;
  lastSeenAt?: number;
  waiter?: Waiter;
  assigned?: boolean;
  /** Addresses of the Job's pod, set once a poll from one is verified. */
  podIps?: string[];
  /** Verify again on the next poll: the held connection dropped abnormally. */
  reverify?: boolean;
  /** The lookup in flight for this slot, shared by concurrent polls. */
  lookup?: Promise<string[] | undefined>;
  lastLookupAt?: number;
  lookupErrorLogged?: boolean;
};

export type WarmAssignResult =
  | "claimed"
  | "miss"
  | "org_limited"
  | "invalid"
  | "refused"
  | "unacknowledged";

type PendingAck = {
  executionId: string;
  podIps: string[];
  jobName?: string;
  settle: (decision: WarmAckDecision | "timeout") => void;
};

export type WarmPoolStats = {
  ready: number;
  starting: number;
  total: number;
};

const DEFAULT_STARTUP_GRACE_MS = 180_000;
// Covers the pod's database check and one in-cluster round trip with room
// to spare; it only delays the fallback when a pod never answers. Shared
// with the pod, which waits longer for the answer (warm-pool-protocol.ts).
const DEFAULT_ACK_TIMEOUT_MS = WARM_POOL_ACK_WINDOW_MS;
const ORG_CLAIM_WINDOW_MS = 60_000;
// A used pod is replaced in roughly 20 s, so the pool serves about three
// claims per pod per minute; one organization may use half of that.
const POOL_CLAIMS_PER_POD_PER_MINUTE = 3;
const ORG_SHARE_OF_POOL = 0.5;
const MIN_ORG_CLAIMS_PER_MINUTE = 5;
// Warm Jobs are created outside the per-run Job semaphore so a dispatch never
// waits behind a refill; this bounds the refill burst instead.
const MAX_PENDING_CREATES = 4;
// Slack after the per-run deadline before the executor deletes a claimed Job.
const CLAIMED_JOB_GRACE_MS = 60_000;
const KEEPALIVE_DELAY_MS = 5000;
// An unverified poll is answered after this delay, and the pod's address is
// looked up at most once per LOOKUP_MIN_INTERVAL_MS per slot, so neither a
// pod that is not Running yet nor someone replaying a token can turn polls
// into a stream of Kubernetes API calls.
const UNVERIFIED_ANSWER_DELAY_MS = 1000;
const LOOKUP_MIN_INTERVAL_MS = 1500;
// How long the request that started a lookup waits for it before being told
// to poll again. The call itself keeps the slot busy until it settles.
const LOOKUP_TIMEOUT_MS = 5000;
const IPV4_MAPPED_PREFIX = "::ffff:";
// Tokens are 32 random bytes as hex (defaultToken). Anything else is refused
// before it touches the slot map.
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;
const DEFAULT_POLL_GRACE_MS = 15_000;
const DEFAULT_MAINTAIN_INTERVAL_MS = 5000;
const MAX_REPLACE_LEAD_MS = 60_000;
const MAX_CREATE_BACKOFF_MS = 60_000;
// Spreads retirement over the last fifth of the idle lifetime so pods created
// together (at startup) are not all replaced in the same instant.
const RETIRE_JITTER_FRACTION = 0.2;

function defaultToken(): string {
  return randomBytes(32).toString("hex");
}

function readToken(req: IncomingMessage): string | undefined {
  const header = req.headers[WARM_POOL_TOKEN_HEADER];
  return typeof header === "string" && TOKEN_SHAPE.test(header)
    ? header
    : undefined;
}

function normalizeAddress(address: string | undefined): string | undefined {
  return address?.startsWith(IPV4_MAPPED_PREFIX)
    ? address.slice(IPV4_MAPPED_PREFIX.length)
    : address;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms
    );
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function defaultOrgClaimsPerMinute(size: number): number {
  return Math.max(
    MIN_ORG_CLAIMS_PER_MINUTE,
    Math.floor(size * POOL_CLAIMS_PER_POD_PER_MINUTE * ORG_SHARE_OF_POOL)
  );
}

export class WarmPool {
  private readonly slots = new Map<string, Slot>();
  // Claim timestamps per organization inside the last ORG_CLAIM_WINDOW_MS.
  private readonly orgClaims = new Map<string, number[]>();
  // Claimed Jobs and when the executor deletes them if still around.
  private readonly claimedJobs = new Map<string, number>();
  // Offered executions waiting for their pod's ack, by slot token.
  private readonly pendingAcks = new Map<string, PendingAck>();
  private pendingCreates = 0;
  private readonly options: Required<WarmPoolOptions>;
  private readonly deps: Required<WarmPoolDeps>;
  private interval: NodeJS.Timeout | undefined;
  private stopped = false;
  private createFailures = 0;
  private nextCreateAt = 0;

  constructor(options: WarmPoolOptions, deps: WarmPoolDeps) {
    // Each optional field resolved on its own: a caller passing a key as
    // undefined (index.ts does, from config) still gets the default.
    this.options = {
      size: options.size,
      idleTtlMs: options.idleTtlMs,
      longPollMs: options.longPollMs,
      claimUrl: options.claimUrl,
      preloadActionPrefixes: options.preloadActionPrefixes,
      runDeadlineMs: options.runDeadlineMs,
      orgClaimsPerMinute:
        options.orgClaimsPerMinute ?? defaultOrgClaimsPerMinute(options.size),
      ackTimeoutMs: options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS,
      startupGraceMs: options.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS,
      pollGraceMs: options.pollGraceMs ?? DEFAULT_POLL_GRACE_MS,
      replaceLeadMs:
        options.replaceLeadMs ??
        Math.min(MAX_REPLACE_LEAD_MS, options.idleTtlMs / 4),
      maintainIntervalMs:
        options.maintainIntervalMs ?? DEFAULT_MAINTAIN_INTERVAL_MS,
    };
    this.deps = {
      createJob: deps.createJob,
      deleteJob: deps.deleteJob,
      lookupPodIps: deps.lookupPodIps,
      now: deps.now ?? Date.now,
      random: deps.random ?? Math.random,
      newToken: deps.newToken ?? defaultToken,
    };
  }

  /**
   * The longest a pod waits for work before exiting on its own. Covers the
   * idle lifetime plus the windows in which the executor may still answer, so
   * the executor's 410 normally ends the pod first; this only matters when the
   * executor is gone.
   */
  get podMaxIdleMs(): number {
    const { idleTtlMs, startupGraceMs, longPollMs, pollGraceMs } = this.options;
    return idleTtlMs + startupGraceMs + longPollMs + pollGraceMs;
  }

  get enabled(): boolean {
    return this.options.size > 0 && !this.stopped;
  }

  start(): void {
    if (this.options.size <= 0 || this.interval) {
      return;
    }
    this.maintain();
    this.interval = setInterval(
      () => this.maintain(),
      this.options.maintainIntervalMs
    );
    this.interval.unref();
  }

  /**
   * Stop refilling and tell every waiting pod to exit. Pods between polls get
   * 410 (or connection refused) on their next poll.
   */
  stop(): void {
    this.stopped = true;
    // Offers still waiting fall back to per-run Jobs; late acks get 410.
    for (const entry of [...this.pendingAcks.values()]) {
      entry.settle("timeout");
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    for (const slot of this.slots.values()) {
      if (slot.waiter) {
        this.respondToWaiter(slot, 410);
      } else {
        // Still booting or between polls: it would otherwise wait out its
        // grace period against an executor that is gone.
        this.deleteJobQuietly(slot);
      }
    }
    this.slots.clear();
    this.publishGauges();
  }

  stats(): WarmPoolStats {
    let ready = 0;
    let starting = 0;
    for (const slot of this.slots.values()) {
      if (this.isReady(slot)) {
        ready++;
      } else if (slot.lastSeenAt === undefined) {
        starting++;
      }
    }
    return { ready, starting, total: this.slots.size };
  }

  /**
   * Handle a warm pod's long-poll. Holds the request open until the pod is
   * assigned a run (200), the long-poll window ends (204), or the pod is no
   * longer part of the pool (410).
   */
  handleClaimRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!this.acceptsBodylessPost(req, res)) {
      return;
    }
    const token = readToken(req);
    const slot = token ? this.slots.get(token) : undefined;
    if (!slot || this.stopped) {
      res.writeHead(410);
      res.end();
      return;
    }

    const now = this.deps.now();
    slot.lastSeenAt = now;

    if (now >= slot.retireAt) {
      this.removeSlot(slot);
      res.writeHead(410);
      res.end();
      this.maintain();
      return;
    }

    const remote = normalizeAddress(req.socket?.remoteAddress);
    if (slot.podIps !== undefined && !slot.reverify) {
      if (remote !== undefined && slot.podIps.includes(remote)) {
        this.holdRequest(slot, res);
      } else {
        this.rejectImpostor(slot, res, remote);
      }
      return;
    }

    // Not verified (first poll, or the held connection dropped): the request
    // must come from the token's own pod. Until that is confirmed it is never
    // held, so nothing can be assigned to it.
    this.verifyThenHold(slot, res, remote);
  }

  private verifyThenHold(
    slot: Slot,
    res: ServerResponse,
    remote: string | undefined
  ): void {
    const { jobName, jobUid } = slot;
    if (!(jobName && jobUid)) {
      this.answerLater(res, 204);
      return;
    }

    // Only the request that starts a lookup waits for it; any other poll in
    // the meantime, or within the minimum interval, is answered later. So no
    // number of requests can pile up behind one lookup or multiply them.
    const now = this.deps.now();
    if (
      slot.lookup !== undefined ||
      (slot.lastLookupAt !== undefined &&
        now - slot.lastLookupAt < LOOKUP_MIN_INTERVAL_MS)
    ) {
      this.answerLater(res, 204);
      return;
    }
    slot.lastLookupAt = now;
    // The slot stays busy until the Kubernetes call itself settles, so a
    // hanging API server gets at most one open call per slot. The timeout
    // only bounds how long this request waits for the answer.
    const call = this.deps.lookupPodIps({ name: jobName, uid: jobUid });
    slot.lookup = call;
    const clear = (): void => {
      if (slot.lookup === call) {
        slot.lookup = undefined;
      }
    };
    call.then(clear, clear);
    const lookup = withTimeout(call, LOOKUP_TIMEOUT_MS);

    lookup.then(
      (podIps) => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        if (!this.slots.has(slot.token) || this.stopped) {
          res.writeHead(410);
          res.end();
          return;
        }
        if (podIps === undefined || podIps.length === 0) {
          this.answerLater(res, 204);
          return;
        }
        if (remote === undefined || !podIps.includes(remote)) {
          this.rejectImpostor(slot, res, remote);
          return;
        }
        // Only a pod's first verification proves the pool can start pods; a
        // re-verification must not wipe out backoff earned by other slots.
        if (slot.podIps === undefined) {
          this.createFailures = 0;
        }
        slot.podIps = podIps;
        slot.reverify = false;
        this.holdRequest(slot, res);
      },
      (error: unknown) => {
        // Logged once per slot: a Kubernetes API outage would otherwise log
        // once per poll of every warm pod.
        if (!slot.lookupErrorLogged) {
          slot.lookupErrorLogged = true;
          logSystemError(
            ErrorCategory.INFRASTRUCTURE,
            "[WarmPool] Could not look up a warm pod's address; it will retry",
            error,
            { job_name: jobName }
          );
        }
        this.answerLater(res, 204);
      }
    );
  }

  private answerLater(res: ServerResponse, status: 204 | 410): void {
    const timer = setTimeout(() => {
      if (!(res.writableEnded || res.destroyed)) {
        res.writeHead(status);
        res.end();
      }
    }, UNVERIFIED_ANSWER_DELAY_MS);
    timer.unref();
  }

  /**
   * Claims and acks carry no body. Refuse one that does without reading it,
   * so neither endpoint can be used to stream data into the executor.
   */
  private acceptsBodylessPost(
    req: IncomingMessage,
    res: ServerResponse
  ): boolean {
    if (req.method !== "POST") {
      req.resume();
      res.writeHead(405);
      res.end();
      return false;
    }
    const contentLength = req.headers["content-length"];
    if (
      req.headers["transfer-encoding"] !== undefined ||
      (contentLength !== undefined && contentLength !== "0")
    ) {
      res.writeHead(400, { Connection: "close" });
      res.end();
      req.destroy();
      return false;
    }
    req.resume();
    return true;
  }

  /** Hold a verified pod's request open until it is assigned or times out. */
  private holdRequest(slot: Slot, res: ServerResponse): void {
    // A pod has one claim request open at a time. A second one means the
    // first was abandoned (its connection may not have closed yet).
    this.respondToWaiter(slot, 204);
    // Notice a pod that vanished without closing its connection sooner than
    // the long-poll window would.
    res.socket?.setKeepAlive(true, KEEPALIVE_DELAY_MS);

    const timer = setTimeout(() => {
      if (slot.waiter?.res === res) {
        slot.lastSeenAt = this.deps.now();
        this.respondToWaiter(slot, 204);
        this.publishGauges();
      }
    }, this.options.longPollMs);
    timer.unref();

    slot.waiter = { res, timer };
    res.on("close", () => {
      if (slot.waiter?.res === res) {
        clearTimeout(timer);
        slot.waiter = undefined;
        // Dropped without an answer: the pod may be gone and its address
        // handed to another pod, so check again before holding the next poll.
        if (!res.writableEnded) {
          slot.reverify = true;
        }
        this.publishGauges();
      }
    });
    this.publishGauges();
  }

  /**
   * A valid token presented from an address that is not its pod's: the token
   * leaked. Burn the slot (its pod is told to exit or its Job deleted) so the
   * token is worth nothing, and raise a security signal.
   */
  private rejectImpostor(
    slot: Slot,
    res: ServerResponse,
    remote: string | undefined
  ): void {
    logSecurityEvent("warm_pool_claim_address_mismatch", {
      job_name: slot.jobName ?? "unknown",
      remote_address: remote ?? "unknown",
    });
    this.respondToWaiter(slot, 410);
    this.removeSlot(slot);
    this.deleteJobQuietly(slot);
    res.writeHead(410);
    res.end();
    // Backs off like a failed start, so repeated mismatches (a token being
    // replayed, or a network that rewrites source addresses) quiet the pool
    // instead of churning Jobs.
    this.recordStartFailure(new Error("warm pool claim address mismatch"));
    this.maintain();
  }

  /**
   * Offer an execution to a ready pod and wait for it to acknowledge. Anything
   * but "claimed" means the caller starts a per-run Job instead:
   *  - miss            no pod is ready (or the pool is stopped)
   *  - org_limited     this organization used its share of claims this minute
   *  - invalid         a pod would reject the assignment
   *  - refused         the pod checked the execution and declined it
   *  - unacknowledged  no answer in time (pod gone, connection dead)
   * In the last two cases the pod is told it may not run the execution (any
   * later ack gets 410), so the per-run Job is the only one that runs it.
   * Never throws.
   */
  async tryAssign(
    assignment: WarmAssignment,
    organizationId: string
  ): Promise<WarmAssignResult> {
    if (!this.enabled) {
      return "miss";
    }

    const now = this.deps.now();
    const recentClaims = this.recentOrgClaims(organizationId, now);
    if (recentClaims.length >= this.options.orgClaimsPerMinute) {
      return "org_limited";
    }

    const candidates = [...this.slots.values()]
      .filter((slot) => this.isReady(slot) && now < slot.retireAt)
      // Use the pod closest to retirement first; it would be replaced soonest.
      .sort((a, b) => a.retireAt - b.retireAt);

    // Checked exactly as the pod will check it, after the same JSON round
    // trip, so a malformed assignment never spends a pod.
    let body: string;
    try {
      body = JSON.stringify(assignment);
      const check = warmAssignmentSchema.safeParse(JSON.parse(body));
      if (!check.success) {
        throw new Error(check.error.message);
      }
    } catch (error) {
      logSystemError(
        ErrorCategory.WORKFLOW_ENGINE,
        "[WarmPool] Assignment would be rejected by a warm pod; using a per-run Job",
        error
      );
      return "invalid";
    }

    const slot = this.handOver(candidates, body);
    if (!slot) {
      this.publishGauges();
      return "miss";
    }

    // Counted now so concurrent offers respect the share; given back below if
    // the pod does not take the run.
    recentClaims.push(now);
    this.orgClaims.set(organizationId, recentClaims);
    // Refill while the pod checks the execution.
    this.maintain();

    const decision = await this.awaitAck(slot, assignment.executionId);
    if (decision === "accept") {
      if (slot.jobName) {
        this.claimedJobs.set(
          slot.jobName,
          this.deps.now() + this.options.runDeadlineMs + CLAIMED_JOB_GRACE_MS
        );
      }
      console.log(
        `[WarmPool] Warm Job ${slot.jobName ?? "unknown"} took execution ${assignment.executionId}`
      );
      return "claimed";
    }

    const claims = this.orgClaims.get(organizationId);
    const index = claims?.lastIndexOf(now) ?? -1;
    if (claims && index >= 0) {
      claims.splice(index, 1);
    }
    this.deleteJobQuietly(slot);
    console.warn(
      `[WarmPool] Warm Job ${slot.jobName ?? "unknown"} did not take execution ${assignment.executionId} (${decision}); starting a per-run Job`
    );
    return decision === "refuse" ? "refused" : "unacknowledged";
  }

  /**
   * Write the assignment to the first candidate that accepts the write. The
   * slot leaves the pool before the write, so its token can never be offered
   * another run.
   */
  private handOver(candidates: Slot[], body: string): Slot | undefined {
    for (const slot of candidates) {
      const waiter = slot.waiter;
      if (!waiter) {
        continue;
      }
      slot.assigned = true;
      this.removeSlot(slot);
      try {
        waiter.res.writeHead(200, { "Content-Type": "application/json" });
        waiter.res.end(body);
      } catch (error) {
        logSystemError(
          ErrorCategory.INFRASTRUCTURE,
          "[WarmPool] Failed to hand assignment to warm pod, trying next",
          error,
          { job_name: slot.jobName ?? "unknown" }
        );
        continue;
      }
      return slot;
    }
    return undefined;
  }

  private awaitAck(
    slot: Slot,
    executionId: string
  ): Promise<WarmAckDecision | "timeout"> {
    return new Promise((resolve) => {
      const settle = (decision: WarmAckDecision | "timeout"): void => {
        clearTimeout(timer);
        if (this.pendingAcks.get(slot.token) === entry) {
          this.pendingAcks.delete(slot.token);
        }
        resolve(decision);
      };
      const timer = setTimeout(() => settle("timeout"), this.options.ackTimeoutMs);
      timer.unref();
      const entry: PendingAck = {
        executionId,
        podIps: slot.podIps ?? [],
        jobName: slot.jobName,
        settle,
      };
      this.pendingAcks.set(slot.token, entry);
    });
  }

  /**
   * A pod's answer to an offered execution. 200 to an "accept" is the only
   * thing that lets the pod run it, and it is only given while the executor
   * is still waiting; after that the executor has started a per-run Job and
   * the ack gets 410.
   */
  handleAckRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!this.acceptsBodylessPost(req, res)) {
      return;
    }
    const token = readToken(req);
    const entry = token ? this.pendingAcks.get(token) : undefined;
    if (!entry || req.headers[WARM_POOL_EXECUTION_HEADER] !== entry.executionId) {
      res.writeHead(410);
      res.end();
      return;
    }
    const remote = normalizeAddress(req.socket?.remoteAddress);
    if (remote === undefined || !entry.podIps.includes(remote)) {
      logSecurityEvent("warm_pool_claim_address_mismatch", {
        job_name: entry.jobName ?? "unknown",
        remote_address: remote ?? "unknown",
      });
      res.writeHead(410);
      res.end();
      return;
    }
    // An accept whose connection is already gone cannot receive the 200, so
    // it must not count: leave the offer to time out into a per-run Job.
    if (req.socket?.destroyed) {
      return;
    }
    const decision = req.headers[WARM_POOL_DECISION_HEADER];
    if (decision !== "accept" && decision !== "refuse") {
      res.writeHead(400);
      res.end();
      return;
    }
    // Settled before answering, in the same tick: the timeout cannot fire in
    // between, so a 200 here always means the executor will not start a Job.
    entry.settle(decision);
    res.writeHead(200);
    res.end();
  }

  private recentOrgClaims(organizationId: string, now: number): number[] {
    const since = now - ORG_CLAIM_WINDOW_MS;
    return (this.orgClaims.get(organizationId) ?? []).filter(
      (at) => at > since
    );
  }

  /** Drop dead and retired slots, then top the pool back up to size. */
  maintain(): void {
    if (this.stopped || this.options.size <= 0) {
      return;
    }
    const now = this.deps.now();
    const { startupGraceMs, longPollMs, pollGraceMs, replaceLeadMs } =
      this.options;

    // Keep the per-organization window bounded to active organizations.
    for (const [organizationId, claims] of this.orgClaims) {
      const recent = claims.filter((at) => at > now - ORG_CLAIM_WINDOW_MS);
      if (recent.length === 0) {
        this.orgClaims.delete(organizationId);
      } else {
        this.orgClaims.set(organizationId, recent);
      }
    }

    // Backstop for the per-run deadline the pod enforces itself.
    for (const [jobName, deleteAt] of this.claimedJobs) {
      if (now >= deleteAt) {
        this.claimedJobs.delete(jobName);
        this.deps.deleteJob(jobName).catch(() => {
          // Usually already gone: finished and removed by its TTL.
        });
      }
    }

    for (const slot of [...this.slots.values()]) {
      if (slot.waiter) {
        if (now >= slot.retireAt) {
          this.respondToWaiter(slot, 410);
          this.removeSlot(slot);
        }
        continue;
      }
      const quietSince = slot.lastSeenAt ?? slot.createdAt;
      const graceMs =
        slot.lastSeenAt === undefined
          ? startupGraceMs
          : longPollMs + pollGraceMs;
      if (now - quietSince > graceMs || now >= slot.retireAt + pollGraceMs) {
        this.removeSlot(slot);
        this.deleteJobQuietly(slot);
        if (slot.lastSeenAt === undefined) {
          // Never came up (bad image, crash loop, no DB): back off like a
          // failed create instead of churning a new Job every few minutes.
          this.recordStartFailure(
            new Error(`warm pod ${slot.jobName ?? "unknown"} never polled`)
          );
        }
      }
    }

    let live = 0;
    for (const slot of this.slots.values()) {
      if (now < slot.retireAt - replaceLeadMs) {
        live++;
      }
    }

    if (now >= this.nextCreateAt) {
      for (
        let missing = this.options.size - live;
        missing > 0 && this.pendingCreates < MAX_PENDING_CREATES;
        missing--
      ) {
        this.createSlot(now);
      }
    }

    this.publishGauges();
  }

  private isReady(slot: Slot): boolean {
    const res = slot.waiter?.res;
    return Boolean(res && !res.writableEnded && !res.destroyed);
  }

  private createSlot(now: number): void {
    const token = this.deps.newToken();
    const jitter = 1 - RETIRE_JITTER_FRACTION * this.deps.random();
    const slot: Slot = {
      token,
      createdAt: now,
      retireAt: now + Math.floor(this.options.idleTtlMs * jitter),
    };
    // In the map before the Job exists, so a pod that polls fast is known.
    this.slots.set(token, slot);
    this.pendingCreates++;

    this.deps
      .createJob({
        token,
        claimUrl: this.options.claimUrl,
        maxIdleMs: this.podMaxIdleMs,
        preloadActionPrefixes: this.options.preloadActionPrefixes,
      })
      .then((job) => {
        slot.jobName = job.name;
        slot.jobUid = job.uid;
        if (!slot.assigned && (this.stopped || !this.slots.has(token))) {
          this.deleteJobQuietly(slot);
        }
      })
      .catch((error: unknown) => {
        this.slots.delete(token);
        this.recordStartFailure(error);
        this.publishGauges();
      })
      .finally(() => {
        this.pendingCreates--;
      });
  }

  private recordStartFailure(error: unknown): void {
    this.createFailures++;
    const backoffMs = Math.min(
      MAX_CREATE_BACKOFF_MS,
      1000 * 2 ** (this.createFailures - 1)
    );
    this.nextCreateAt = this.deps.now() + backoffMs;
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      "[WarmPool] A warm runner failed to start",
      error,
      { retry_in_ms: String(backoffMs) }
    );
  }

  private removeSlot(slot: Slot): void {
    if (slot.waiter) {
      clearTimeout(slot.waiter.timer);
      slot.waiter = undefined;
    }
    this.slots.delete(slot.token);
  }

  private respondToWaiter(slot: Slot, status: 204 | 410): void {
    const waiter = slot.waiter;
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timer);
    slot.waiter = undefined;
    if (!(waiter.res.writableEnded || waiter.res.destroyed)) {
      waiter.res.writeHead(status);
      waiter.res.end();
    }
  }

  private deleteJobQuietly(slot: Slot): void {
    if (!slot.jobName) {
      return;
    }
    const jobName = slot.jobName;
    this.deps.deleteJob(jobName).catch((error: unknown) => {
      // The Job's own deadline and TTL clean it up regardless.
      console.warn(
        `[WarmPool] Could not delete warm Job ${jobName}; its deadline will end it:`,
        error instanceof Error ? error.message : error
      );
    });
  }

  private publishGauges(): void {
    const { ready, starting } = this.stats();
    const metrics = getMetricsCollector();
    metrics.setGauge(MetricNames.EXECUTOR_WARM_POOL_READY, ready);
    metrics.setGauge(MetricNames.EXECUTOR_WARM_POOL_STARTING, starting);
  }
}
