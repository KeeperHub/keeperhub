import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setGauge = vi.fn();
const logSecurityEvent = vi.fn();
const logSystemError = vi.fn();
vi.mock("../lib/metrics", () => ({
  getMetricsCollector: () => ({ setGauge }),
}));
vi.mock("../lib/logging", () => ({
  ErrorCategory: { INFRASTRUCTURE: "infrastructure", WORKFLOW_ENGINE: "wf" },
  logSystemError: (...args: unknown[]) => logSystemError(...args),
  logSecurityEvent: (...args: unknown[]) => logSecurityEvent(...args),
}));

const { WarmPool, defaultOrgClaimsPerMinute } = await import("./warm-pool");
const { WARM_POOL_TOKEN_HEADER } = await import("./warm-pool-protocol");

const POD_IP = "10.1.2.3";

class FakeResponse extends EventEmitter {
  statusCode: number | undefined;
  body: string | undefined;
  writableEnded = false;
  destroyed = false;

  writeHead(status: number): this {
    if (this.statusCode !== undefined) {
      throw new Error("headers already sent");
    }
    this.statusCode = status;
    return this;
  }

  end(body?: string): this {
    this.body = body;
    this.writableEnded = true;
    this.emit("close");
    return this;
  }

  disconnect(): void {
    this.destroyed = true;
    this.emit("close");
  }
}

function claimRequest(
  token: string | undefined,
  options: { method?: string; remoteAddress?: string } = {}
): IncomingMessage {
  return {
    method: options.method ?? "POST",
    headers: token ? { [WARM_POOL_TOKEN_HEADER]: token } : {},
    socket: { remoteAddress: options.remoteAddress ?? `::ffff:${POD_IP}` },
    resume: vi.fn(),
    destroy: vi.fn(),
  } as unknown as IncomingMessage;
}

// Lets the pool's promise chains (Job create, pod address lookup) settle.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const assignment = {
  workflowId: "wf-1",
  executionId: "exec-1",
  input: { blockNumber: 1 },
  triggerType: "block",
};

function tokenFor(n: number): string {
  return n.toString(16).padStart(64, "0");
}

type MakePoolOverrides = {
  size?: number;
  orgClaimsPerMinute?: number;
  createJob?: ReturnType<typeof vi.fn>;
  lookupPodIps?: ReturnType<typeof vi.fn>;
};

function makePool(overrides: MakePoolOverrides = {}) {
  const clock = { now: 1_000_000 };
  const tokens: string[] = [];
  let counter = 0;
  const createJob =
    overrides.createJob ??
    vi.fn((params: { token: string }) =>
      Promise.resolve({ name: `job-${params.token}`, uid: `uid-${params.token}` })
    );
  const deleteJob = vi.fn(() => Promise.resolve());
  const lookupPodIps =
    overrides.lookupPodIps ?? vi.fn(() => Promise.resolve([POD_IP]));
  const pool = new WarmPool(
    {
      size: overrides.size ?? 2,
      idleTtlMs: 600_000,
      longPollMs: 20_000,
      claimUrl: "http://10.0.0.5:3080",
      ownerId: "executor-0",
      preloadActionPrefixes: "web3/",
      runDeadlineMs: 300_000,
      maintainIntervalMs: 60_000,
      orgClaimsPerMinute: overrides.orgClaimsPerMinute,
    },
    {
      createJob,
      deleteJob,
      lookupPodIps,
      now: () => clock.now,
      random: () => 0,
      newToken: () => {
        counter++;
        const token = tokenFor(counter);
        tokens.push(token);
        return token;
      },
    }
  );
  const poll = async (
    token: string,
    remoteAddress?: string
  ): Promise<FakeResponse> => {
    const res = new FakeResponse();
    pool.handleClaimRequest(
      claimRequest(token, { remoteAddress }),
      res as unknown as ServerResponse
    );
    await flush();
    return res;
  };
  const start = async (): Promise<void> => {
    pool.start();
    await flush();
  };
  return {
    pool,
    createJob,
    deleteJob,
    lookupPodIps,
    tokens,
    clock,
    poll,
    start,
  };
}

describe("WarmPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setGauge.mockClear();
    logSecurityEvent.mockClear();
    logSystemError.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts size warm Jobs with the claim URL and the pod's max idle", async () => {
    const { pool, createJob, start } = makePool();
    await start();

    expect(createJob).toHaveBeenCalledTimes(2);
    const params = createJob.mock.calls[0][0];
    expect(params.claimUrl).toBe("http://10.0.0.5:3080");
    expect(params.ownerId).toBe("executor-0");
    expect(params.maxIdleMs).toBe(pool.podMaxIdleMs);
    expect(params.maxIdleMs).toBeGreaterThan(600_000);
    pool.stop();
  });

  it("does nothing when size is 0", () => {
    const { pool, createJob } = makePool({ size: 0 });
    pool.start();
    expect(createJob).not.toHaveBeenCalled();
    expect(pool.enabled).toBe(false);
    expect(pool.tryAssign(assignment, "org-1")).toBe("miss");
  });

  describe("claim endpoint", () => {
    it("answers 410 to an unknown, missing or malformed token and 405 to a non-POST", async () => {
      const { pool, tokens, start } = makePool();
      await start();

      for (const token of [tokenFor(999), undefined, `${tokens[0]}x`]) {
        const res = new FakeResponse();
        pool.handleClaimRequest(
          claimRequest(token),
          res as unknown as ServerResponse
        );
        expect(res.statusCode).toBe(410);
      }

      const get = new FakeResponse();
      pool.handleClaimRequest(
        claimRequest(tokens[0], { method: "GET" }),
        get as unknown as ServerResponse
      );
      expect(get.statusCode).toBe(405);
      pool.stop();
    });

    it("refuses a request that carries a body without reading it", async () => {
      const { pool, tokens, start } = makePool();
      await start();
      const req = claimRequest(tokens[0]);
      (req.headers as Record<string, string>)["content-length"] = "1048576";
      const res = new FakeResponse();
      pool.handleClaimRequest(req, res as unknown as ServerResponse);
      expect(res.statusCode).toBe(400);
      expect(req.resume).not.toHaveBeenCalled();
      expect(req.destroy).toHaveBeenCalled();
      expect(pool.stats().ready).toBe(0);
      pool.stop();
    });

    it("holds a request only after confirming it comes from the token's pod", async () => {
      const { pool, tokens, start, poll, lookupPodIps } = makePool();
      await start();

      const res = await poll(tokens[0]);
      expect(lookupPodIps).toHaveBeenCalledWith({
        name: `job-${tokens[0]}`,
        uid: `uid-${tokens[0]}`,
      });
      expect(res.statusCode).toBeUndefined();
      expect(pool.stats().ready).toBe(1);
      pool.stop();
    });

    it("answers 204 after a delay while the pod has no address yet, without holding", async () => {
      const lookupPodIps = vi.fn(() => Promise.resolve(undefined));
      const { pool, tokens, start, poll } = makePool({ lookupPodIps });
      await start();

      const res = await poll(tokens[0]);
      expect(res.statusCode).toBeUndefined();
      expect(pool.tryAssign(assignment, "org-1")).toBe("miss");
      vi.advanceTimersByTime(1000);
      expect(res.statusCode).toBe(204);
      pool.stop();
    });

    it("shares one lookup between concurrent polls and limits how often it runs", async () => {
      let resolveLookup: (ips: string[] | undefined) => void = () => undefined;
      const lookupPodIps = vi.fn(
        () =>
          new Promise<string[] | undefined>((resolve) => {
            resolveLookup = resolve;
          })
      );
      const { pool, tokens, start, poll, clock } = makePool({ lookupPodIps });
      await start();

      const starter = await poll(tokens[0]);
      const second = await poll(tokens[0]);
      const third = await poll(tokens[0]);
      expect(lookupPodIps).toHaveBeenCalledTimes(1);
      resolveLookup([POD_IP]);
      await flush();

      // Only the request that started the lookup is held; the others were
      // answered later, never held behind it.
      expect(starter.statusCode).toBeUndefined();
      expect(pool.stats().ready).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(second.statusCode).toBe(204);
      expect(third.statusCode).toBe(204);

      // Verified now: the next poll is held without another API call.
      clock.now += 100;
      await poll(tokens[0]);
      expect(lookupPodIps).toHaveBeenCalledTimes(1);
      expect(pool.stats().ready).toBe(1);
      pool.stop();
    });

    it("looks a pod up at most once per interval while it is unverified", async () => {
      const lookupPodIps = vi.fn(() => Promise.resolve(undefined));
      const { pool, tokens, start, poll, clock } = makePool({ lookupPodIps });
      await start();

      await poll(tokens[0]);
      await poll(tokens[0]);
      expect(lookupPodIps).toHaveBeenCalledTimes(1);
      clock.now += 1500;
      await poll(tokens[0]);
      expect(lookupPodIps).toHaveBeenCalledTimes(2);
      pool.stop();
    });

    it("logs a failing lookup once per slot, not once per poll", async () => {
      const lookupPodIps = vi.fn(() => Promise.reject(new Error("api down")));
      const { pool, tokens, start, poll, clock } = makePool({ lookupPodIps });
      await start();

      for (let i = 0; i < 3; i++) {
        await poll(tokens[0]);
        clock.now += 1500;
      }
      expect(lookupPodIps).toHaveBeenCalledTimes(3);
      expect(logSystemError).toHaveBeenCalledTimes(1);
      pool.stop();
    });

    it("answers a request whose lookup hangs, without starting more calls", async () => {
      let failLookup: (error: Error) => void = () => undefined;
      const lookupPodIps = vi.fn(
        () =>
          new Promise<string[] | undefined>((_resolve, reject) => {
            failLookup = reject;
          })
      );
      const { pool, tokens, start, poll, clock } = makePool({ lookupPodIps });
      await start();

      const first = await poll(tokens[0]);
      vi.advanceTimersByTime(5000);
      await flush();
      vi.advanceTimersByTime(1000);
      expect(first.statusCode).toBe(204);

      // The hung call still counts: later polls do not open another one.
      clock.now += 10_000;
      await poll(tokens[0]);
      expect(lookupPodIps).toHaveBeenCalledTimes(1);

      // Once it finally fails, the next poll may look up again.
      failLookup(new Error("connection reset"));
      await flush();
      clock.now += 1500;
      await poll(tokens[0]);
      expect(lookupPodIps).toHaveBeenCalledTimes(2);
      pool.stop();
    });

    it("checks the pod again after every long-poll window", async () => {
      const { pool, tokens, start, poll, lookupPodIps, clock } = makePool();
      await start();

      await poll(tokens[0]);
      vi.advanceTimersByTime(20_000);
      clock.now += 20_000;
      await poll(tokens[0]);
      expect(lookupPodIps).toHaveBeenCalledTimes(2);
      expect(pool.stats().ready).toBe(1);
      pool.stop();
    });

    it("accepts any of the pod's addresses (dual-stack)", async () => {
      const lookupPodIps = vi.fn(() => Promise.resolve([POD_IP, "fd00::12"]));
      const { pool, tokens, start, poll } = makePool({ lookupPodIps });
      await start();

      const res = await poll(tokens[0], "fd00::12");
      expect(res.statusCode).toBeUndefined();
      expect(pool.stats().ready).toBe(1);
      pool.stop();
    });

    it("checks the pod again after its held connection dropped", async () => {
      const { pool, tokens, start, poll, lookupPodIps, clock } = makePool();
      await start();

      const res = await poll(tokens[0]);
      expect(lookupPodIps).toHaveBeenCalledTimes(1);
      res.disconnect();
      clock.now += 1500;
      await poll(tokens[0]);
      expect(lookupPodIps).toHaveBeenCalledTimes(2);
      pool.stop();
    });

    it("burns the slot when a valid token is used from another address", async () => {
      const { pool, tokens, start, poll, deleteJob, createJob, clock } =
        makePool();
      await start();

      const stolen = await poll(tokens[0], "10.9.9.9");
      expect(stolen.statusCode).toBe(410);
      expect(logSecurityEvent).toHaveBeenCalledWith(
        "warm_pool_claim_address_mismatch",
        expect.objectContaining({ remote_address: "10.9.9.9" })
      );
      expect(deleteJob).toHaveBeenCalledWith(`job-${tokens[0]}`);
      // The real pod is now told to exit. The mismatch backs the pool off
      // like a failed start, so no replacement is churned out at once...
      expect((await poll(tokens[0])).statusCode).toBe(410);
      expect(createJob).toHaveBeenCalledTimes(2);
      pool.maintain();
      expect(createJob).toHaveBeenCalledTimes(2);
      // ...but it does come once the backoff has passed.
      clock.now += 1000;
      pool.maintain();
      expect(createJob).toHaveBeenCalledTimes(3);
      pool.stop();
    });

    it("burns the slot when a verified pod's token later arrives from elsewhere", async () => {
      const { pool, tokens, start, poll } = makePool();
      await start();

      const waiting = await poll(tokens[0]);
      const stolen = await poll(tokens[0], "10.9.9.9");
      expect(stolen.statusCode).toBe(410);
      expect(waiting.statusCode).toBe(410);
      expect(pool.tryAssign(assignment, "org-1")).toBe("miss");
      pool.stop();
    });
  });

  describe("assignment", () => {
    it("hands the assignment to a waiting pod exactly once and refills", async () => {
      const { pool, createJob, tokens, poll, start } = makePool();
      await start();

      const res = await poll(tokens[0]);
      expect(pool.tryAssign(assignment, "org-1")).toBe("claimed");
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body ?? "")).toEqual(assignment);

      // The token is spent: polling again with it is told to exit.
      expect((await poll(tokens[0])).statusCode).toBe(410);
      // A replacement Job was started for the claimed slot.
      expect(createJob).toHaveBeenCalledTimes(3);
      // The other pod has not polled, so a second run misses.
      expect(
        pool.tryAssign({ ...assignment, executionId: "exec-2" }, "org-1")
      ).toBe("miss");
      pool.stop();
    });

    it("never gives two runs to one pod, even with the same execution id", async () => {
      const { pool, tokens, poll, start } = makePool();
      await start();
      const a = await poll(tokens[0]);
      const b = await poll(tokens[1]);

      expect(pool.tryAssign(assignment, "org-1")).toBe("claimed");
      expect(pool.tryAssign(assignment, "org-1")).toBe("claimed");
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      expect(pool.tryAssign(assignment, "org-1")).toBe("miss");
      pool.stop();
    });

    it("answers 204 when the long-poll window ends and keeps the slot", async () => {
      const { pool, tokens, poll, start, clock } = makePool();
      await start();

      const res = await poll(tokens[0]);
      vi.advanceTimersByTime(20_000);
      clock.now += 20_000;
      expect(res.statusCode).toBe(204);
      expect(pool.stats().ready).toBe(0);

      const next = await poll(tokens[0]);
      expect(next.statusCode).toBeUndefined();
      expect(pool.tryAssign(assignment, "org-1")).toBe("claimed");
      expect(next.statusCode).toBe(200);
      pool.stop();
    });

    it("never assigns to a pod whose connection closed", async () => {
      const { pool, tokens, poll, start } = makePool();
      await start();

      const res = await poll(tokens[0]);
      res.disconnect();
      expect(pool.stats().ready).toBe(0);
      expect(pool.tryAssign(assignment, "org-1")).toBe("miss");
      expect(res.statusCode).toBeUndefined();
      pool.stop();
    });

    it("answers the earlier request 204 when the same pod polls twice", async () => {
      const { pool, tokens, poll, start } = makePool();
      await start();

      const first = await poll(tokens[0]);
      const second = await poll(tokens[0]);
      expect(first.statusCode).toBe(204);
      expect(pool.tryAssign(assignment, "org-1")).toBe("claimed");
      expect(second.statusCode).toBe(200);
      pool.stop();
    });

    it("tries the next pod when writing to one fails, and still never reuses it", async () => {
      const { pool, tokens, poll, start } = makePool();
      await start();
      const broken = await poll(tokens[0]);
      const healthy = await poll(tokens[1]);
      broken.writeHead = () => {
        throw new Error("socket gone");
      };

      expect(pool.tryAssign(assignment, "org-1")).toBe("claimed");
      expect(healthy.statusCode).toBe(200);
      expect((await poll(tokens[0])).statusCode).toBe(410);
      pool.stop();
    });

    it("falls back when a warm pod would reject the assignment", async () => {
      const { pool, tokens, poll, start } = makePool();
      await start();
      const res = await poll(tokens[0]);

      // NaN serializes to null, which the pod-side schema rejects.
      expect(
        pool.tryAssign({ ...assignment, receivedAt: Number.NaN }, "org-1")
      ).toBe("invalid");
      expect(res.statusCode).toBeUndefined();
      expect(pool.tryAssign(assignment, "org-1")).toBe("claimed");
      pool.stop();
    });

    it("falls back when the assignment cannot be serialized", async () => {
      const { pool, tokens, poll, start } = makePool();
      await start();
      const res = await poll(tokens[0]);

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(pool.tryAssign({ ...assignment, input: circular }, "org-1")).toBe(
        "invalid"
      );
      expect(res.statusCode).toBeUndefined();
      expect(pool.tryAssign(assignment, "org-1")).toBe("claimed");
      pool.stop();
    });
  });

  describe("fair share", () => {
    it("derives the per-organization limit from the pool size, at least 5", () => {
      expect(defaultOrgClaimsPerMinute(1)).toBe(5);
      expect(defaultOrgClaimsPerMinute(4)).toBe(6);
      expect(defaultOrgClaimsPerMinute(10)).toBe(15);
      expect(defaultOrgClaimsPerMinute(32)).toBe(48);
    });

    it("limits one organization's claims per minute; misses use no quota", async () => {
      const { pool, tokens, poll, clock, start } = makePool({
        size: 4,
        orgClaimsPerMinute: 2,
      });
      await start();

      // A miss before any pod is waiting does not count.
      expect(pool.tryAssign(assignment, "org-a")).toBe("miss");

      const claimAll = async (org: string): Promise<string> => {
        for (const token of [...tokens]) {
          await poll(token);
        }
        return pool.tryAssign(assignment, org);
      };
      expect(await claimAll("org-a")).toBe("claimed");
      expect(await claimAll("org-a")).toBe("claimed");
      expect(await claimAll("org-a")).toBe("org_limited");
      // org_limited leaves the waiting pods in place for others.
      expect(pool.tryAssign(assignment, "org-b")).toBe("claimed");

      // The window is one minute: limited just before it ends, free at it.
      clock.now += 59_999;
      expect(await claimAll("org-a")).toBe("org_limited");
      clock.now += 1;
      expect(await claimAll("org-a")).toBe("claimed");
      pool.stop();
    });
  });

  describe("lifecycle", () => {
    it("retires a pod past its idle lifetime with 410 and replaces it", async () => {
      const { pool, tokens, poll, clock, createJob, start } = makePool({
        size: 1,
      });
      await start();
      expect(createJob).toHaveBeenCalledTimes(1);

      clock.now += 600_000;
      expect((await poll(tokens[0])).statusCode).toBe(410);
      expect(createJob).toHaveBeenCalledTimes(2);
      pool.stop();
    });

    it("starts a replacement before a pod retires", async () => {
      const { pool, clock, createJob, start, poll, tokens } = makePool({
        size: 1,
      });
      await start();
      // A healthy pod holding its claim request.
      await poll(tokens[0]);
      // replaceLeadMs = min(60s, idleTtl / 4) = 60s.
      clock.now += 600_000 - 59_000;
      pool.maintain();
      expect(createJob).toHaveBeenCalledTimes(2);
      pool.stop();
    });

    it("drops a pod that never polls, deletes its Job and backs off", async () => {
      const { pool, clock, createJob, deleteJob, tokens, start } = makePool({
        size: 1,
      });
      await start();
      expect(pool.stats().starting).toBe(1);

      clock.now += 180_001;
      pool.maintain();
      expect(deleteJob).toHaveBeenCalledWith(`job-${tokens[0]}`);
      // Counted as a start failure: no immediate replacement.
      expect(createJob).toHaveBeenCalledTimes(1);
      clock.now += 1000;
      pool.maintain();
      expect(createJob).toHaveBeenCalledTimes(2);
      pool.stop();
    });

    it("keeps the backoff when an already-verified pod is checked again", async () => {
      let failNext = false;
      const createJob = vi.fn((params: { token: string }) =>
        failNext
          ? Promise.reject(new Error("quota"))
          : Promise.resolve({
              name: `job-${params.token}`,
              uid: `uid-${params.token}`,
            })
      );
      const { pool, tokens, poll, clock, start } = makePool({
        size: 2,
        createJob,
      });
      await start();
      await poll(tokens[0]);
      await poll(tokens[1]);
      clock.now += 2000;

      // A claim frees a slot; its replacement fails and backs the pool off.
      failNext = true;
      expect(pool.tryAssign(assignment, "org-1")).toBe("claimed");
      await flush();
      const callsAfterFailure = createJob.mock.calls.length;

      // The surviving pod is re-verified after its long-poll window.
      vi.advanceTimersByTime(20_000);
      await poll(tokens[1]);
      expect(pool.stats().ready).toBe(1);

      // Still inside the backoff window: no new create.
      pool.maintain();
      expect(createJob.mock.calls.length).toBe(callsAfterFailure);
      pool.stop();
    });

    it("backs off after a Job create failure", async () => {
      const createJob = vi.fn(() => Promise.reject(new Error("quota")));
      const { pool, clock, start } = makePool({ size: 1, createJob });
      await start();
      expect(pool.stats().total).toBe(0);

      pool.maintain();
      expect(createJob).toHaveBeenCalledTimes(1);

      clock.now += 1000;
      pool.maintain();
      expect(createJob).toHaveBeenCalledTimes(2);
      pool.stop();
    });

    it("creates at most 4 warm Jobs at a time", () => {
      const createJob = vi.fn(
        () => new Promise<{ name: string }>(() => undefined)
      );
      const { pool } = makePool({ size: 10, createJob });
      pool.start();
      expect(createJob).toHaveBeenCalledTimes(4);
      pool.maintain();
      expect(createJob).toHaveBeenCalledTimes(4);
      pool.stop();
    });

    it("deletes a claimed Job once the run deadline plus grace has passed", async () => {
      const { pool, tokens, poll, clock, deleteJob, start } = makePool({
        size: 1,
      });
      await start();
      await poll(tokens[0]);
      expect(pool.tryAssign(assignment, "org-1")).toBe("claimed");

      clock.now += 300_000 + 59_000;
      pool.maintain();
      expect(deleteJob).not.toHaveBeenCalledWith(`job-${tokens[0]}`);
      clock.now += 1001;
      pool.maintain();
      expect(deleteJob).toHaveBeenCalledWith(`job-${tokens[0]}`);
      pool.stop();
    });

    it("deletes a Job whose create finishes after the pool stopped", async () => {
      let resolveCreate: (job: { name: string }) => void = () => undefined;
      const createJob = vi.fn(
        () =>
          new Promise<{ name: string }>((resolve) => {
            resolveCreate = resolve;
          })
      );
      const { pool, deleteJob } = makePool({ size: 1, createJob });
      pool.start();
      pool.stop();
      resolveCreate({ name: "late-job" });
      await flush();
      expect(deleteJob).toHaveBeenCalledWith("late-job");
    });

    it("tells waiting pods to exit on stop and stops assigning", async () => {
      const { pool, tokens, poll, start } = makePool();
      await start();

      const res = await poll(tokens[0]);
      pool.stop();
      expect(res.statusCode).toBe(410);
      expect(pool.enabled).toBe(false);
      expect(pool.tryAssign(assignment, "org-1")).toBe("miss");
      expect((await poll(tokens[0])).statusCode).toBe(410);
    });
  });
});
