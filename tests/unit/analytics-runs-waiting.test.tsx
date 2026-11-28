// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// The Projects drawer fetches on its own; the paging test needs the table only.
vi.mock("@/components/analytics/project-drawer", () => ({
  ProjectDrawer: () => null,
}));

import { createStore, Provider } from "jotai";
import { RunsTable, RunsTableContent } from "@/components/analytics/runs-table";
import type { UnifiedRun } from "@/lib/analytics/types";
import { analyticsRunsAtom } from "@/lib/atoms/analytics";

const UNLOCK = 1_796_126_400;

function run(
  id: string,
  minutesAgo: number,
  extra: Partial<UnifiedRun> = {}
): UnifiedRun {
  const startedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id,
    source: "workflow",
    status: "success",
    startedAt,
    completedAt: startedAt,
    durationMs: 900,
    workflowId: "wf-a",
    workflowName: "Keeper",
    directType: null,
    network: null,
    networks: [],
    gasNetworks: [],
    gasCostWei: null,
    transactionHashes: [],
    gasUsedWei: null,
    totalSteps: 3,
    completedSteps: 3,
    error: null,
    errorCode: null,
    errorType: null,
    errorCategory: null,
    ...extra,
  };
}

function waiting(id: string, minutesAgo: number, workflowId = "wf-a") {
  return run(id, minutesAgo, {
    status: "skipped",
    workflowId,
    skipReason: "bundle-waiting",
    waiting: {
      notBefore: UNLOCK,
      firstAllowedBlock: 21_400_421,
      latestBlock: 21_400_159,
      sendAheadBlocks: 2,
    },
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { status: 200 }))
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(runs: UnifiedRun[]): Promise<void> {
  await act(async () => {
    root.render(
      <RunsTableContent
        isEmpty={runs.length === 0}
        loading={false}
        pageLoading={false}
        runs={runs}
      />
    );
  });
}

function groups(): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-testid="analytics-waiting-group"]'
    ),
  ];
}

describe("waiting runs in the Analytics runs table", () => {
  it("shares one row per workflow and Not before, with the skipped-while-running count", async () => {
    await render([
      waiting("w3", 1),
      run("k1", 2, {
        status: "skipped",
        skipReason: "while-running",
        refusals: 4,
      }),
      waiting("w2", 3),
      waiting("w1", 4),
      waiting("b1", 5, "wf-b"),
      run("ok", 6),
    ]);
    expect(groups()).toHaveLength(2);
    expect(
      container.querySelector('[data-testid="analytics-waiting-count"]')
        ?.textContent
    ).toBe("3 Waiting");
    expect(groups()[0].getAttribute("title")).toContain(
      "3 waiting, 4 skipped while running (1 run), from "
    );
    // Run numbers are left out: the table does not number runs.
    expect(groups()[0].getAttribute("title")).not.toContain("#");
    // The success run keeps its own row: 2 groups + 1 run.
    expect(container.querySelectorAll("tbody > tr")).toHaveLength(3);
  });

  it("opens from the chevron, which says whether the row is open", async () => {
    await render([waiting("w2", 1), waiting("w1", 2)]);
    const chevron = groups()[0].querySelector("button");
    expect(chevron?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      chevron?.click();
    });
    expect(
      groups()[0].querySelector("button")?.getAttribute("aria-expanded")
    ).toBe("true");
    const details =
      container.querySelector('[data-testid="analytics-waiting-details"]')
        ?.textContent ?? "";
    expect(details).toContain(
      "A waiting run counts toward your plan's runs like any other run."
    );
    expect(fetch).toHaveBeenCalledWith("/api/analytics/runs/w2/steps");
    expect(fetch).toHaveBeenCalledTimes(1);
    // An older run joining the row (a new oldest run) keeps it open, with no remount or refetch.
    const row = groups()[0];
    await render([waiting("w2", 1), waiting("w1", 2), waiting("w0", 3)]);
    expect(
      container.querySelector('[data-testid="analytics-waiting-details"]')
    ).not.toBeNull();
    expect(groups()[0]).toBe(row);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("closes an open row on another page, even one with the same Not before at the top", async () => {
    const page = (number: number, runs: UnifiedRun[]) => ({
      runs,
      nextCursor: null,
      total: 200,
      page: number,
      pageSize: 50,
    });
    const second = page(2, [waiting("v2", 60), waiting("v1", 61)]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/analytics/runs?")
          ? new Response(JSON.stringify(second), { status: 200 })
          : new Response("[]", { status: 200 })
      )
    );
    const store = createStore();
    store.set(analyticsRunsAtom, page(1, [waiting("w2", 1), waiting("w1", 2)]));
    await act(async () => {
      root.render(
        <Provider store={store}>
          <RunsTable />
        </Provider>
      );
    });
    const chevron = () => groups()[0]?.querySelector("button");
    await act(async () => {
      chevron()?.click();
    });
    expect(chevron()?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Next page"]')
        ?.click();
    });
    expect(groups()[0]?.getAttribute("title")).toContain("2 waiting");
    expect(store.get(analyticsRunsAtom)?.page).toBe(2);
    expect(chevron()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens only the group clicked when two groups share a Not before", async () => {
    await render([waiting("w3", 1), run("ok", 2), waiting("w1", 3)]);
    expect(groups()).toHaveLength(2);
    await act(async () => {
      groups()[1].querySelector("button")?.click();
    });
    expect(
      groups().map((group) =>
        group.querySelector("button")?.getAttribute("aria-expanded")
      )
    ).toEqual(["false", "true"]);
  });

  it("links the workflow, shows the network, and pins the details to the visible width", async () => {
    await render([{ ...waiting("w2", 1), networks: ["1"] }, waiting("w1", 2)]);
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-testid="analytics-waiting-workflow-link"]'
    );
    expect(link?.getAttribute("href")).toBe("/workflows/wf-a");
    expect(
      container.querySelector('[data-testid="analytics-waiting-network"]')
        ?.textContent
    ).not.toBe("-");
    await act(async () => {
      groups()[0].querySelector("button")?.click();
    });
    const details = container.querySelector(
      '[data-testid="analytics-waiting-details"]'
    );
    expect(details?.className).toContain("sticky");
    expect(details?.className).toContain("w-[100cqw]");
    expect(details?.closest(".overflow-x-auto")?.className).toContain(
      "@container"
    );
  });

  it("sums the group's gas and says the other steps sent transactions", async () => {
    const gas = (wei: string) => ({
      gasUsedWei: wei,
      networks: ["1"],
      gasNetworks: ["1"],
      transactionHashes: [{ hash: "0x1", nodeId: "n", nodeName: "Pay" }],
    });
    await render([
      { ...waiting("w3", 1), ...gas("1000000000000000") },
      waiting("w2", 2),
      { ...waiting("w1", 3), ...gas("2000000000000000") },
    ]);
    const cell = () =>
      container.querySelector('[data-testid="analytics-waiting-gas"]')
        ?.textContent ?? "";
    expect(cell()).toMatch(/^0\.003\b/);
    const title = () =>
      container
        .querySelector('[data-testid="analytics-waiting-gas"]')
        ?.getAttribute("title");
    // A single-chain total names how many runs it sums.
    expect(title()).toBe("Total for the 3 runs in this row");
    await act(async () => {
      groups()[0].querySelector("button")?.click();
    });
    expect(
      container.querySelector('[data-testid="analytics-waiting-details"]')
        ?.textContent
    ).toContain(
      "The runs' other steps still ran; some sent transactions. Only the latest run's steps are shown."
    );
    // No run paid: the cell stays empty.
    await render([waiting("v2", 1), waiting("v1", 2)]);
    expect(cell()).toBe("-");
    expect(title()).toBeNull();
    await render([{ ...waiting("s1", 1), ...gas("1000000000000000") }]);
    expect(title()).toBe("Total for the 1 run in this row");
  });

  it("shows Composed for a group that paid gas on two chains, its tooltip about these runs", async () => {
    const paid = (chain: string) => ({
      gasUsedWei: "1000000000000000",
      networks: [chain],
      gasNetworks: [chain],
    });
    await render([
      { ...waiting("x2", 1), ...paid("1") },
      { ...waiting("x1", 2), ...paid("137") },
    ]);
    const gas = container.querySelector<HTMLElement>(
      '[data-testid="analytics-waiting-gas"]'
    );
    expect(gas?.textContent).toBe("Composed");
    // Composed has no single total, so no total title.
    expect(gas?.getAttribute("title")).toBeNull();
    // The focused trigger opens its tooltip, which Radix measures with an observer jsdom lacks.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {
          // jsdom does no layout
        }
        unobserve(): void {
          // jsdom does no layout
        }
        disconnect(): void {
          // jsdom does no layout
        }
      }
    );
    await act(async () => {
      gas
        ?.querySelector<HTMLElement>("span")
        ?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    const tip = document.body.textContent ?? "";
    expect(tip).toContain("These runs spent gas on ");
    expect(tip).toContain(
      "Those networks have different native tokens, so there is no single total to show."
    );
    expect(tip).not.toContain("Expand the run");
  });
});
