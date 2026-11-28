// @vitest-environment jsdom
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
import { RUN_OUTCOME_REASON } from "@/lib/workflow/executor/run-outcome-keys";
import { currentWorkflowIdAtom } from "@/lib/workflow/store";

const UNLOCK = 1_796_126_400;
const WAITING_INFO = {
  notBefore: UNLOCK,
  firstAllowedBlock: 21_400_421,
  latestBlock: 21_400_159,
  sendAheadBlocks: 2,
};

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

function waitingRun(id: string, minutesAgo: number) {
  return run(id, minutesAgo, {
    status: "skipped",
    error: RUN_OUTCOME_REASON.waiting,
    skipReason: "bundle-waiting",
    waiting: WAITING_INFO,
  });
}

function skippedWhileRunning(
  id: string,
  minutesAgo: number,
  refusals: number | null
) {
  return run(id, minutesAgo, {
    status: "skipped",
    error:
      "Execution skipped: the previous run of this workflow was still running.",
    skipReason: "while-running",
    refusals,
  });
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
  getExecutions.mockResolvedValue({
    executions: [
      waitingRun("w3", 1),
      waitingRun("w2", 2),
      waitingRun("w1", 3),
      run("s1", 9),
    ],
    nextCursor: null,
    total: 4,
  });
  getExecutionLogs.mockResolvedValue({
    execution: { id: "w3", status: "skipped", transactionHashes: [] },
    logs: [
      step("trigger", "Block Trigger", "trigger", { blockNumber: 1 }),
      step("keeper", "Keeper call", "web3/write-contract", {
        success: true,
        route: "waiting",
        included: false,
        ...WAITING_INFO,
      }),
    ],
  });
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

describe("waiting runs in the Runs panel", () => {
  it("collapses back-to-back waiting runs into one row with a count", async () => {
    await render();
    const groups = container.querySelectorAll(
      '[data-testid="waiting-run-group"]'
    );
    expect(groups).toHaveLength(1);
    const row = byTestId("waiting-run-row");
    // The row keeps the oldest run's number; the others keep their own.
    expect(row?.textContent).toContain("Run #2");
    expect(byTestId("waiting-run-count")?.textContent).toBe("3 waiting");
    expect(byTestId("waiting-run-line")?.textContent).toMatch(
      /^not before (\w{3} \d{1,2}, )?\d{2}:\d{2}$/
    );
    expect(row?.getAttribute("title")).toContain("3 waiting, #2 to #4");
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Run #1");
    expect(container.textContent).not.toContain("Run #3");
    expect(byTestId("waiting-run-details")).toBeNull();
  });

  it("opens to the reason, the span and the latest run's steps", async () => {
    await render();
    await act(async () => {
      byTestId("waiting-run-row")?.click();
    });
    await flush();
    expect(getExecutionLogs).toHaveBeenCalledWith("w3");
    expect(byTestId("waiting-run-row")?.getAttribute("aria-expanded")).toBe(
      "true"
    );
    const details = byTestId("waiting-run-details")?.textContent ?? "";
    expect(details).toContain("Waiting for Not before: ");
    expect(details).toContain(
      "The Write Contract step sent nothing and did not touch the wallet."
    );
    expect(details).toContain("3 waiting, #2 to #4, from ");
    expect(details).toContain(
      "A waiting run counts toward your plan's runs like any other run."
    );
    expect(details).not.toContain("not billed");
    expect(details).toContain(
      "First allowed block 21,400,421, 262 blocks away. The step sends 2 blocks before it (Send ahead)."
    );
    expect(container.textContent).toContain("Steps of the latest waiting run");
    const chip = byTestId("step-waiting");
    expect(chip?.textContent).toBe("Waiting");
    expect(chip?.getAttribute("title")).toMatch(
      /^Waiting: Not before is still/
    );
    // Closes again from the chevron, which says whether the row is open.
    const chevron = byTestId("waiting-run-chevron");
    expect(chevron?.getAttribute("aria-label")).toBe("Collapse");
    expect(chevron?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      chevron?.click();
    });
    expect(byTestId("waiting-run-details")).toBeNull();
    expect(byTestId("waiting-run-chevron")?.getAttribute("aria-expanded")).toBe(
      "false"
    );
  });

  it("says Max Fee held the step back when every target ahead was skipped for it", async () => {
    getExecutionLogs.mockResolvedValue({
      execution: { id: "w3", status: "skipped", transactionHashes: [] },
      logs: [
        step("keeper", "Keeper call", "web3/write-contract", {
          success: true,
          route: "waiting",
          included: false,
          bundleTargetsSkipped: [
            { block: 21_400_421, reason: "max-fee-below-projected-base-fee" },
          ],
          ...WAITING_INFO,
        }),
      ],
    });
    await render();
    await act(async () => {
      byTestId("waiting-run-row")?.click();
    });
    await flush();
    expect(byTestId("step-waiting")?.getAttribute("title")).toBe(
      "Waiting: Max Fee held back the targets ahead, so this step sent nothing (no gas was paid); raise Max Fee if it keeps waiting."
    );
  });

  it("counts skipped-while-running rows between waiting runs in the row", async () => {
    getExecutions.mockResolvedValue({
      executions: [
        waitingRun("w2", 1),
        skippedWhileRunning("k2", 2, 7),
        skippedWhileRunning("k1", 3, null),
        waitingRun("w1", 4),
        skippedWhileRunning("k0", 5, 3),
      ],
      nextCursor: null,
      total: 5,
    });
    await render();
    expect(
      container.querySelectorAll('[data-testid="waiting-run-group"]')
    ).toHaveLength(1);
    expect(byTestId("waiting-run-count")?.textContent).toBe("2 waiting");
    expect(byTestId("waiting-run-row")?.getAttribute("title")).toContain(
      "2 waiting, 8 skipped while running (2 runs), #2 to #5"
    );
    // The skipped row below the last waiting run stays its own row.
    expect(container.textContent).toContain("Run #1");
    expect(byTestId("waiting-run-row")?.textContent).toContain("Run #2");
  });

  it("stays open when Load more brings older runs into the row", async () => {
    getExecutions.mockResolvedValueOnce({
      executions: [waitingRun("w3", 1), waitingRun("w2", 2)],
      nextCursor: "c1",
      total: 3,
    });
    await render();
    await act(async () => {
      byTestId("waiting-run-row")?.click();
    });
    await flush();
    expect(byTestId("waiting-run-details")).not.toBeNull();
    getExecutions.mockResolvedValueOnce({
      executions: [waitingRun("w1", 3)],
      nextCursor: null,
      total: 3,
    });
    const more = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Load ")
    );
    await act(async () => {
      more?.click();
    });
    await flush();
    expect(byTestId("waiting-run-count")?.textContent).toBe("3 waiting");
    expect(byTestId("waiting-run-details")).not.toBeNull();
  });
});
