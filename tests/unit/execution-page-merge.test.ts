import { describe, expect, it } from "vitest";
import {
  appendPage,
  type ExecutionPage,
  emptyExecutionPage,
  mergeFirstPage,
  nextPageSize,
  replacePage,
} from "@/lib/workflow/execution-page-merge";

type Run = { id: string; status: string };

const WF = "wf_a";
const OTHER_WF = "wf_b";

function page(
  executions: Run[],
  nextCursor: string | null,
  total: number,
  workflowId: string = WF
): ExecutionPage<Run> {
  return { workflowId, executions, nextCursor, total };
}

describe("replacePage", () => {
  it("replaces the list with a page for the same workflow", () => {
    const first = page([{ id: "b", status: "running" }], "after-b", 5);
    expect(replacePage(emptyExecutionPage(WF), first)).toEqual(first);
  });

  it("drops a page for another workflow", () => {
    const shown = page([{ id: "x", status: "success" }], null, 1, OTHER_WF);
    const stale = page([{ id: "b", status: "running" }], "after-b", 5);
    expect(replacePage(shown, stale)).toBe(shown);
  });
});

describe("mergeFirstPage", () => {
  it("is the page itself on a fresh load", () => {
    const first = page([{ id: "b", status: "running" }], "after-b", 5);
    expect(mergeFirstPage(emptyExecutionPage(WF), first)).toEqual(first);
  });

  it("replaces covered rows in place so status changes show", () => {
    const loaded = page(
      [
        { id: "b", status: "running" },
        { id: "a", status: "success" },
      ],
      null,
      2
    );
    const refreshed = page(
      [
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      "after-a",
      2
    );
    expect(mergeFirstPage(loaded, refreshed).executions).toEqual(
      refreshed.executions
    );
  });

  it("prepends new runs and keeps the row they pushed out, with the loaded cursor", () => {
    // Page size 2: the viewer has page one loaded, then run c starts.
    const loaded = page(
      [
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      "after-a",
      2
    );
    const refreshed = page(
      [
        { id: "c", status: "running" },
        { id: "b", status: "success" },
      ],
      "after-b",
      3
    );
    expect(mergeFirstPage(loaded, refreshed)).toEqual({
      workflowId: WF,
      executions: [
        { id: "c", status: "running" },
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      // a is still the tail of what is on screen.
      nextCursor: "after-a",
      total: 3,
    });
  });

  it("keeps a null cursor when every page was already loaded and a run arrives", () => {
    const loaded = page(
      [
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      null,
      2
    );
    const refreshed = page(
      [
        { id: "c", status: "running" },
        { id: "b", status: "success" },
      ],
      "after-b",
      3
    );
    const merged = mergeFirstPage(loaded, refreshed);
    expect(merged.executions.map((run) => run.id)).toEqual(["c", "b", "a"]);
    expect(merged.nextCursor).toBeNull();
  });

  it("keeps older loaded pages below a refreshed first page", () => {
    const loaded = page(
      [
        { id: "d", status: "running" },
        { id: "c", status: "success" },
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      null,
      4
    );
    const refreshed = page(
      [
        { id: "d", status: "success" },
        { id: "c", status: "success" },
      ],
      "after-c",
      4
    );
    const merged = mergeFirstPage(loaded, refreshed);
    expect(merged.executions.map((run) => run.id)).toEqual([
      "d",
      "c",
      "b",
      "a",
    ]);
    expect(merged.executions[0]?.status).toBe("success");
    expect(merged.nextCursor).toBeNull();
  });

  it("drops everything outside a complete page, which empties the panel after a purge", () => {
    const loaded = page(
      [
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      "after-a",
      40
    );
    expect(mergeFirstPage(loaded, page([], null, 0))).toEqual(
      page([], null, 0)
    );
  });

  it("drops a first page for another workflow instead of merging it", () => {
    const shown = page([{ id: "x", status: "running" }], null, 1, OTHER_WF);
    const stale = page([{ id: "a", status: "success" }], "after-a", 30);
    expect(mergeFirstPage(shown, stale)).toBe(shown);
  });

  it("does not let a slow load for the previous workflow leak into the next one", () => {
    // Open A (slow), switch to B before A answers, then A's page lands,
    // then B's first poll lands.
    const emptyB = emptyExecutionPage(OTHER_WF);
    const lateA = page(
      [
        { id: "a2", status: "success" },
        { id: "a1", status: "success" },
      ],
      "after-a1",
      50
    );
    const afterA = replacePage(emptyB, lateA);
    expect(afterA).toBe(emptyB);

    const pollB = page([{ id: "b1", status: "running" }], null, 1, OTHER_WF);
    const afterB = mergeFirstPage(afterA, pollB);
    expect(afterB.executions.map((run) => run.id)).toEqual(["b1"]);
    expect(afterB.total).toBe(1);
  });
});

describe("nextPageSize", () => {
  it.each([
    ["a full page remains", 56, 20, 20],
    ["a partial last page remains", 56, 40, 16],
    ["a new run arrived on top and is already on screen", 57, 41, 16],
    ["everything is loaded", 56, 56, 0],
    ["a purge left fewer runs than are shown", 0, 2, 0],
  ])("%s: total %i, loaded %i -> %i", (_label, total, loaded, expected) => {
    expect(nextPageSize(total, loaded, 20)).toBe(expected);
  });
});

describe("appendPage", () => {
  it("appends older rows, skips duplicates and advances the cursor", () => {
    const loaded = page(
      [
        { id: "c", status: "success" },
        { id: "b", status: "success" },
      ],
      "after-b",
      4
    );
    const older = page(
      [
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      null,
      4
    );
    expect(appendPage(loaded, older)).toEqual({
      workflowId: WF,
      executions: [
        { id: "c", status: "success" },
        { id: "b", status: "success" },
        { id: "a", status: "success" },
      ],
      nextCursor: null,
      total: 4,
    });
  });

  it("drops an older page for another workflow", () => {
    const shown = page(
      [{ id: "x", status: "success" }],
      "after-x",
      9,
      OTHER_WF
    );
    const stale = page([{ id: "a", status: "success" }], null, 4);
    expect(appendPage(shown, stale)).toBe(shown);
  });
});
