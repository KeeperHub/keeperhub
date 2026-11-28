// @vitest-environment jsdom
// The Runs panel for a bundle step's public copy: unconfirmed runs, Pending steps, fallback reasons.
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getExecutions, getExecutionLogs } = vi.hoisted(() => ({
  getExecutions: vi.fn(),
  getExecutionLogs: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/workflows/wf-1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useActiveOrganization: () => ({ data: { id: "org-1" } }) },
}));
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  api: { workflow: { getExecutions, getExecutionLogs } },
}));

import { WorkflowRuns } from "@/components/workflow/workflow-runs";
import {
  NEVER_MINED_RUN_ERROR,
  publicCopyNotLandedReason,
  RUN_OUTCOME_REASON,
} from "@/lib/workflow/executor/run-outcome-keys";
import { currentWorkflowIdAtom } from "@/lib/workflow/store";

function run(
  id: string,
  minutesAgo: number,
  extra: Record<string, unknown> = {}
) {
  const startedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id,
    workflowId: "wf-1",
    userId: "u-1",
    status: "success",
    error: null,
    errorType: null,
    errorCategory: null,
    errorCode: null,
    startedAt,
    completedAt: startedAt,
    duration: "900",
    totalSteps: 3,
    completedSteps: 3,
    currentNodeId: null,
    currentNodeName: null,
    lastSuccessfulNodeId: null,
    lastSuccessfulNodeName: null,
    ranVersion: 12,
    refusals: null,
    skipReason: null,
    waiting: null,
    ...extra,
  };
}

function step(id: string, nodeName: string, nodeType: string, output: unknown) {
  const at = new Date().toISOString();
  return {
    id,
    executionId: "w3",
    nodeId: id,
    nodeName,
    nodeType,
    status: "success",
    input: {},
    output,
    error: null,
    startedAt: at,
    completedAt: at,
    duration: "120",
    iterationIndex: null,
    forEachNodeId: null,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(): Promise<void> {
  const store = createStore();
  store.set(currentWorkflowIdAtom, "wf-1");
  await act(async () => {
    root.render(
      <Provider store={store}>
        <WorkflowRuns />
      </Provider>
    );
  });
  await flush();
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

const HASH = `0x${"ab".repeat(32)}`;

async function openRun(label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label)
  );
  await act(async () => {
    button?.click();
  });
  await flush();
}

function only(executions: unknown[]) {
  getExecutions.mockResolvedValue({
    executions,
    nextCursor: null,
    total: executions.length,
  });
}

describe("a bundle step's public copy in the Runs panel", () => {
  it("an unconfirmed run: its own label, a note naming the hash, and an Unconfirmed step", async () => {
    only([run("u1", 1, { status: "unconfirmed" })]);
    getExecutionLogs.mockResolvedValue({
      execution: { id: "u1", status: "unconfirmed", transactionHashes: [] },
      logs: [
        step("keeper", "Keeper call", "web3/write-contract", {
          success: true,
          route: "bundle-and-public",
          included: false,
          pending: true,
          transactionHash: HASH,
        }),
      ],
    });
    await render();
    const dot = container.querySelector('[title^="Unconfirmed - "]');
    expect(dot?.getAttribute("title")).toBe(
      "Unconfirmed - a transaction was sent and is not mined yet; KeeperHub settles the run once it is mined or dropped. If it is mined, the wallet pays its gas, even if it reverts."
    );
    await openRun("Run #1");
    expect(byTestId("run-outcome-reason")?.textContent).toBe(
      `A transaction (${HASH}) was sent and is not mined yet; KeeperHub settles the run once it is mined or dropped. If it is mined, the wallet pays its gas, even if it reverts. If it stays unmined, most often its fee cap is below the base fee; it clears when the base fee falls back under it. KeeperHub does not replace it; raise Max Fee or leave it empty for later runs.`
    );
    const chip = byTestId("step-public-pending");
    expect(chip?.textContent).toBe("Unconfirmed");
    expect(chip?.getAttribute("title")).toBe(
      "Unconfirmed: this step's transaction was sent publicly and is not mined yet; KeeperHub settles the run once it is mined or dropped. If it is mined, the wallet pays its gas, even if it reverts. If it stays unmined, most often its fee cap is below the base fee; it clears when the base fee falls back under it. KeeperHub does not replace it; raise Max Fee or leave it empty for later runs."
    );
    // Never the green "Completed successfully".
    expect(
      container.querySelector('[title="Completed successfully"]')
    ).toBeNull();
  });

  it("a not landed run says why the public fallback was not sent", async () => {
    only([
      run("n1", 1, {
        status: "not_landed",
        error: RUN_OUTCOME_REASON.not_landed,
      }),
    ]);
    getExecutionLogs.mockResolvedValue({
      execution: { id: "n1", status: "not_landed", transactionHashes: [] },
      logs: [
        step("keeper", "Keeper call", "web3/write-contract", {
          success: true,
          route: "bundle",
          included: false,
          notIncludedReason: "not-checked",
          fallbackSent: false,
          fallbackNotSentReason: "check-failed",
        }),
      ],
    });
    await render();
    await openRun("Run #1");
    const reasons = [
      ...container.querySelectorAll('[data-testid="run-outcome-step-reason"]'),
    ].map((node) => node.textContent);
    expect(reasons).toEqual([
      "It could not be checked yet, and it may still land within about a day.",
      "The public fallback was not sent: the call could not be checked.",
    ]);
    expect(container.textContent).not.toContain("would still have worked");
  });

  it("a run whose public copy was dropped: Not landed with the reason, the step Not included", async () => {
    only([
      run("d1", 1, {
        status: "not_landed",
        error: publicCopyNotLandedReason("public-copy-dropped"),
      }),
    ]);
    getExecutionLogs.mockResolvedValue({
      execution: {
        id: "d1",
        status: "not_landed",
        error: publicCopyNotLandedReason("public-copy-dropped"),
        transactionHashes: [],
      },
      logs: [
        step("keeper", "Keeper call", "web3/write-contract", {
          success: true,
          route: "bundle-and-public",
          included: false,
          pending: true,
          transactionHash: HASH,
        }),
      ],
    });
    await render();
    await openRun("Run #1");
    expect(byTestId("run-outcome-reason")?.textContent).toContain(
      "Its public copy was not found on any RPC for three checks"
    );
    expect(byTestId("step-not-included")?.getAttribute("title")).toBe(
      `Not included: this step's bundle was not seen in any of its target blocks. Its public copy was not found on any RPC for three checks, so KeeperHub treats it as dropped. Most often its fee cap was below the base fee, or an RPC rejected it (for example for too little balance): raise Max Fee or leave it empty, and check the wallet's balance. Nothing was mined, and the nonce is free for the wallet's next transaction.`
    );
  });

  it("a step skipped behind a public copy names the copy, and so does the run note", async () => {
    only([
      run("k1", 1, {
        status: "skipped",
        error: RUN_OUTCOME_REASON.skippedPublicCopy,
      }),
    ]);
    getExecutionLogs.mockResolvedValue({
      execution: { id: "k1", status: "skipped", transactionHashes: [] },
      logs: [
        step("keeper", "Keeper call", "web3/write-contract", {
          success: true,
          route: "skipped-in-flight",
          included: false,
          inFlightHash: HASH,
        }),
      ],
    });
    await render();
    await openRun("Run #1");
    expect(byTestId("step-skipped-in-flight")?.getAttribute("title")).toBe(
      `Skipped: an earlier run's public copy (${HASH}) is not mined yet, so this step sent nothing; no gas was paid. KeeperHub checks it every few minutes and stops waiting after a day.`
    );
    expect(byTestId("run-outcome-reason")?.textContent).toBe(
      `An earlier run's public copy (${HASH}) is not mined yet, so the bundle step sent nothing; no gas was paid. KeeperHub checks it every few minutes and stops waiting after a day.`
    );
  });

  it("a step skipped behind a bundle keeps the stored run note", async () => {
    only([
      run("k2", 1, { status: "skipped", error: RUN_OUTCOME_REASON.skipped }),
    ]);
    getExecutionLogs.mockResolvedValue({
      execution: { id: "k2", status: "skipped", transactionHashes: [] },
      logs: [
        step("keeper", "Keeper call", "web3/write-contract", {
          success: true,
          route: "skipped-in-flight",
          included: false,
          inFlightUntilBlock: 21_400_105,
        }),
      ],
    });
    await render();
    await openRun("Run #1");
    expect(byTestId("run-outcome-reason")?.textContent).toBe(
      "This workflow's earlier bundle could still land, so the bundle step sent no transaction."
    );
  });

  it("says when no RPC confirmed taking a pending copy", async () => {
    only([run("u2", 1, { status: "unconfirmed" })]);
    getExecutionLogs.mockResolvedValue({
      execution: { id: "u2", status: "unconfirmed", transactionHashes: [] },
      logs: [
        step("keeper", "Keeper call", "web3/write-contract", {
          success: true,
          route: "bundle-and-public",
          included: false,
          pending: true,
          transactionHash: HASH,
          publicCopy: { hash: HASH, sentAtBlock: 9, accepted: null },
        }),
      ],
    });
    await render();
    await openRun("Run #1");
    expect(byTestId("run-outcome-reason")?.textContent).toContain(
      `A transaction (${HASH}) was sent (no RPC confirmed taking it) and is not mined yet`
    );
    expect(byTestId("step-public-pending")?.getAttribute("title")).toContain(
      "sent publicly (no RPC confirmed taking it) and is not mined yet"
    );
  });

  it.each([
    [
      "its nonce used by another transaction",
      {
        status: "not_landed",
        error: publicCopyNotLandedReason("public-copy-replaced"),
      },
      "Another transaction from the wallet used its nonce first, so its public copy can no longer be mined; no gas was paid for it.",
    ],
    [
      "not mined within a day",
      {
        status: "error",
        error: `${NEVER_MINED_RUN_ERROR}; treating them as dropped after 24h`,
      },
      "Its public copy was not mined within a day; it stays valid until the wallet's next transaction, and KeeperHub no longer watches it.",
    ],
  ])(
    "a pending step whose run ended with %s says so",
    async (_name, settled, line) => {
      only([run("s1", 1, settled)]);
      getExecutionLogs.mockResolvedValue({
        execution: { id: "s1", transactionHashes: [], ...settled },
        logs: [
          step("keeper", "Keeper call", "web3/write-contract", {
            success: true,
            route: "bundle-and-public",
            included: false,
            pending: true,
            transactionHash: HASH,
          }),
        ],
      });
      await render();
      await openRun("Run #1");
      expect(byTestId("step-not-included")?.getAttribute("title")).toBe(
        `Not included: this step's bundle was not seen in any of its target blocks. ${line}`
      );
    }
  );
});
