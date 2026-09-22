import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworksMap, RawWorkflow } from "../../lib/types";
import { logger } from "../../lib/utils/logger";

/**
 * The reconciler's own invalid-config skip line.
 *
 * `synchronizeData` reconciles every 30 seconds and re-maps every workflow, so
 * the generic `skipping workflow ... buildRegistration returned null` line used
 * to repeat once per refused workflow every 30 seconds for the life of the pod.
 * The capability warn in `workflow-mapper.ts` that names the chain gate is
 * latched, so the useful line went quiet after the first pass while this
 * useless one kept going and buried it after log rotation. This suite pins the
 * line as latched per workflow, and pins it as a transition latch rather than a
 * permanent gag: it fires again when a workflow that started registering stops
 * again, and when a workflow leaves the active set and comes back invalid.
 *
 * `reconcile` is exercised directly. The registry is faked so the test needs no
 * Redis, and `buildRegistration` is mocked so a workflow's validity is decided
 * by the case rather than by building a real config.
 */

const { fakeRegistry, buildRegistration } = vi.hoisted(() => {
  const hashes = new Map<string, string>();
  return {
    fakeRegistry: {
      ids: (): string[] => [...hashes.keys()],
      getConfigHash: (id: string): string | undefined => hashes.get(id),
      remove: (id: string): void => {
        hashes.delete(id);
      },
      add: (reg: { workflowId: string; configHash: string }): Promise<void> => {
        hashes.set(reg.workflowId, reg.configHash);
        return Promise.resolve();
      },
      reset: (): void => {
        hashes.clear();
      },
    },
    buildRegistration: vi.fn(),
  };
});

vi.mock("../../src/listener/factory", () => ({
  createRegistry: () => fakeRegistry,
}));
vi.mock("../../src/listener/workflow-mapper", () => ({ buildRegistration }));

import { reconcile, resetReconcilerSkipLatch } from "../../src/main";

const NETWORKS: NetworksMap = {};

/** A registration whose only fields the reconciler reads. */
function validFor(id: string): { workflowId: string; configHash: string } {
  return { workflowId: id, configHash: `${id}-hash` };
}

function workflow(id: string): RawWorkflow {
  return { id };
}

describe("reconciler skip-line latch", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fakeRegistry.reset();
    resetReconcilerSkipLatch();
    buildRegistration.mockReset();
    // `logger.log` carries the per-pass summary and the add/remove lines; it
    // is silenced here so the run is readable and only the warn is asserted.
    vi.spyOn(logger, "log").mockImplementation(() => undefined);
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    warn.mockClear();
  });

  /** Skip lines emitted for `id`, in order. */
  function skipLines(id: string): string[] {
    return warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes(`skipping workflow ${id}`));
  }

  it("logs the skip once across repeated reconciles of the same skipped workflow", async () => {
    // The blocker. Unlatched, this is one line every reconcile pass forever.
    buildRegistration.mockReturnValue(null);
    for (let i = 0; i < 3; i += 1) {
      await reconcile([workflow("wf-skip")], NETWORKS);
    }
    expect(skipLines("wf-skip")).toHaveLength(1);
  });

  it("logs each skipped workflow once, keyed per workflow", async () => {
    // Latched per workflow id, so two refused workflows are two lines, not one.
    buildRegistration.mockReturnValue(null);
    for (let i = 0; i < 3; i += 1) {
      await reconcile([workflow("wf-a"), workflow("wf-b")], NETWORKS);
    }
    expect(skipLines("wf-a")).toHaveLength(1);
    expect(skipLines("wf-b")).toHaveLength(1);
  });

  it("re-reports after the workflow registered in between", async () => {
    // A transition latch, not a permanent gag: a config that becomes valid and
    // later invalid again is reported the second time. Mirrors the mapper's
    // `forgetTraceRefusal` clearing on a successful map.
    buildRegistration.mockReturnValueOnce(null);
    await reconcile([workflow("wf-flap")], NETWORKS);

    buildRegistration.mockReturnValueOnce(validFor("wf-flap"));
    await reconcile([workflow("wf-flap")], NETWORKS);

    buildRegistration.mockReturnValueOnce(null);
    await reconcile([workflow("wf-flap")], NETWORKS);

    expect(skipLines("wf-flap")).toHaveLength(2);
  });

  it("re-reports after the workflow left the active set and came back", async () => {
    // The other clear trigger: dropping a workflow from the active set forgets
    // its latch, so re-adding an invalid one is reported again.
    buildRegistration.mockReturnValue(null);
    await reconcile([workflow("wf-gone")], NETWORKS);

    // Not active this pass, so nothing to skip and the latch is dropped.
    await reconcile([], NETWORKS);

    await reconcile([workflow("wf-gone")], NETWORKS);

    expect(skipLines("wf-gone")).toHaveLength(2);
  });

  it("does not emit the skip line for a workflow that keeps registering", async () => {
    buildRegistration.mockReturnValue(validFor("wf-ok"));
    for (let i = 0; i < 3; i += 1) {
      await reconcile([workflow("wf-ok")], NETWORKS);
    }
    expect(skipLines("wf-ok")).toHaveLength(0);
  });
});
