import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory fake of the coordination.k8s.io Lease API, shared across every
// makeApiClient() call so multiple electors contend for the same lease exactly
// as two pods would against a real API server. resourceVersion drives the
// optimistic-concurrency (compare-and-swap) 409 on replace.
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => {
  const leases = new Map<string, unknown>();
  return {
    leases,
    reset(): void {
      leases.clear();
    },
  };
});

vi.mock("@kubernetes/client-node", () => {
  class ApiException extends Error {
    constructor(public code: number) {
      super(`ApiException ${code}`);
    }
  }
  class V1MicroTime extends Date {}

  type Lease = {
    metadata: { name: string; namespace: string; resourceVersion?: string };
    spec: Record<string, unknown>;
  };

  class FakeCoordinationV1Api {
    async readNamespacedLease({ name }: { name: string }): Promise<Lease> {
      const found = store.leases.get(name);
      if (!found) {
        throw new ApiException(404);
      }
      return structuredClone(found) as Lease;
    }

    async createNamespacedLease({ body }: { body: Lease }): Promise<Lease> {
      const name = body.metadata.name;
      if (store.leases.get(name)) {
        throw new ApiException(409);
      }
      const created = structuredClone(body) as Lease;
      created.metadata.resourceVersion = "1";
      store.leases.set(name, created);
      return structuredClone(created);
    }

    async replaceNamespacedLease({
      name,
      body,
    }: {
      name: string;
      body: Lease;
    }): Promise<Lease> {
      const existing = store.leases.get(name) as Lease | undefined;
      if (!existing) {
        throw new ApiException(404);
      }
      if (body.metadata.resourceVersion !== existing.metadata.resourceVersion) {
        throw new ApiException(409);
      }
      const updated = structuredClone(body) as Lease;
      updated.metadata.resourceVersion = String(
        Number(existing.metadata.resourceVersion ?? "0") + 1,
      );
      store.leases.set(name, updated);
      return structuredClone(updated);
    }
  }

  class KubeConfig {
    loadFromDefault(): void {
      // no-op in tests
    }
    makeApiClient(): FakeCoordinationV1Api {
      return new FakeCoordinationV1Api();
    }
  }

  return {
    ApiException,
    V1MicroTime,
    KubeConfig,
    CoordinationV1Api: FakeCoordinationV1Api,
  };
});

import { LeaderElector } from "../../lib/leader-election.js";

// Sub-second durations keep the test fast while preserving the required
// ordering retryPeriod < renewDeadline < leaseDuration.
const TIMING = {
  leaseDurationSeconds: 0.12,
  renewDeadlineSeconds: 0.06,
  retryPeriodSeconds: 0.02,
};

interface Tracker {
  elector: LeaderElector;
  startedCount: number;
  stoppedCount: number;
}

function makeElector(
  identity: string,
  liveLeaders: Set<string>,
  onConcurrent: (n: number) => void,
): Tracker {
  const tracker: Tracker = {
    startedCount: 0,
    stoppedCount: 0,
    elector: undefined as unknown as LeaderElector,
  };
  tracker.elector = new LeaderElector({
    leaseName: "test-leader",
    namespace: "test-ns",
    holderIdentity: identity,
    ...TIMING,
    onStartedLeading: () => {
      tracker.startedCount += 1;
      liveLeaders.add(identity);
      onConcurrent(liveLeaders.size);
    },
    onStoppedLeading: () => {
      tracker.stoppedCount += 1;
      liveLeaders.delete(identity);
    },
  });
  return tracker;
}

describe("LeaderElector", () => {
  beforeEach(() => {
    store.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("elects exactly one leader when two instances contend", async () => {
    const live = new Set<string>();
    let maxConcurrent = 0;
    const track = (n: number): void => {
      maxConcurrent = Math.max(maxConcurrent, n);
    };

    const a = makeElector("pod-a", live, track);
    const b = makeElector("pod-b", live, track);
    void a.elector.run().catch(() => undefined);
    void b.elector.run().catch(() => undefined);

    await vi.waitFor(() => {
      expect(a.elector.isLeader() || b.elector.isLeader()).toBe(true);
    });
    // Give the follower several retry periods to (wrongly) grab it too.
    await new Promise((r) => setTimeout(r, 100));

    const leaders = [a, b].filter((t) => t.elector.isLeader());
    expect(leaders).toHaveLength(1);
    expect(maxConcurrent).toBe(1);
    expect(store.leases.get("test-leader")).toBeDefined();

    await a.elector.stop();
    await b.elector.stop();
  });

  it("fails over to the standby when the leader stops", async () => {
    const live = new Set<string>();
    let maxConcurrent = 0;
    const track = (n: number): void => {
      maxConcurrent = Math.max(maxConcurrent, n);
    };

    const a = makeElector("pod-a", live, track);
    const b = makeElector("pod-b", live, track);
    void a.elector.run().catch(() => undefined);
    void b.elector.run().catch(() => undefined);

    await vi.waitFor(() => {
      expect(a.elector.isLeader() || b.elector.isLeader()).toBe(true);
    });
    const leader = a.elector.isLeader() ? a : b;
    const standby = leader === a ? b : a;

    await leader.elector.stop();

    await vi.waitFor(
      () => {
        expect(standby.elector.isLeader()).toBe(true);
      },
      { timeout: 2000 },
    );
    expect(maxConcurrent).toBe(1);

    await standby.elector.stop();
  });

  it("keeps renewing the lease while it holds leadership", async () => {
    const live = new Set<string>();
    const a = makeElector("pod-a", live, () => undefined);
    void a.elector.run().catch(() => undefined);

    await vi.waitFor(() => {
      expect(a.elector.isLeader()).toBe(true);
    });

    const firstRenew = (
      store.leases.get("test-leader") as { spec: { renewTime: string } }
    ).spec.renewTime;

    // After several renew cycles the stored renewTime must advance and the
    // start callback must not have fired again (leadership is continuous).
    await new Promise((r) => setTimeout(r, 100));
    const laterRenew = (
      store.leases.get("test-leader") as { spec: { renewTime: string } }
    ).spec.renewTime;

    expect(new Date(laterRenew).getTime()).toBeGreaterThan(
      new Date(firstRenew).getTime(),
    );
    expect(a.elector.isLeader()).toBe(true);
    expect(a.startedCount).toBe(1);

    await a.elector.stop();
  });
});
