// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPickerFilter,
  type PickerFilter,
  PickerFilterButton,
  PickerFilterRow,
  usePickerFilter,
} from "@/components/workflow-picker-filter";
import type { WorkflowEntry } from "@/components/workflow-picker-list";

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
  // A focused filter button opens its tooltip, which Radix measures with an
  // observer jsdom does not have.
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
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const workflows: WorkflowEntry[] = [
  {
    id: "live",
    name: "Hat monitor",
    updatedAt: "2026-10-01T00:00:00.000Z",
    triggerType: "Schedule",
    triggerConfig: { scheduleCron: "*/5 * * * *" },
    enabled: true,
  },
  {
    id: "off",
    name: "Lift alert",
    updatedAt: "2026-10-01T00:00:00.000Z",
    triggerType: "Event",
    triggerConfig: { eventName: "Lift" },
    enabled: false,
  },
  {
    id: "manual",
    name: "One-off query",
    updatedAt: "2026-10-01T00:00:00.000Z",
    triggerType: "Manual",
    triggerConfig: { triggerType: "Manual" },
    enabled: false,
  },
];

// The latest filter of each picker, by panel id, to act on it directly.
const filters: Record<string, PickerFilter> = {};

function Picker({
  panelId,
  panelState = "open",
  list = workflows,
}: {
  panelId: string;
  panelState?: "open" | "collapsed" | "closed";
  list?: WorkflowEntry[];
}): React.ReactNode {
  const filter = usePickerFilter(panelState);
  filters[panelId] = filter;
  const shown = applyPickerFilter(list, filter);
  return (
    <section aria-label={panelId} data-flyout>
      <PickerFilterButton
        filter={filter}
        hasWorkflows={list.length > 0}
        loading={false}
        panelId={panelId}
        panelName={panelId}
      />
      <PickerFilterRow
        filter={filter}
        loading={false}
        panelId={panelId}
        panelName={panelId}
        shownCount={shown.length}
        workflows={list}
      />
      {shown.map((w) => (
        <p data-row={w.id} key={w.id}>
          {w.name}
        </p>
      ))}
    </section>
  );
}

function renderPickers(
  rootProps: Partial<React.ComponentProps<typeof Picker>> = {}
): void {
  act(() =>
    root.render(
      <>
        <Picker panelId="root-filter" {...rootProps} />
        <Picker panelId="project-filter" />
      </>
    )
  );
}

function panel(id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `section[aria-label=${id}]`
  );
  if (!element) {
    throw new Error(`no panel ${id}`);
  }
  return element;
}

function filterButton(id: string): HTMLButtonElement {
  const button = panel(id).querySelector<HTMLButtonElement>(
    "[data-testid=trigger-filter-button]"
  );
  if (!button) {
    throw new Error(`no filter button in ${id}`);
  }
  return button;
}

function rows(id: string): string[] {
  return [...panel(id).querySelectorAll("[data-row]")].map(
    (row) => row.getAttribute("data-row") ?? ""
  );
}

describe("picker filter", () => {
  it("shows its own row, which the button controls by id", () => {
    renderPickers();
    act(() => filterButton("root-filter").click());

    const button = filterButton("root-filter");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe("root-filter");
    expect(document.getElementById("root-filter")).not.toBeNull();
    // The other panel's row stays shut.
    expect(document.getElementById("project-filter")).toBeNull();
    expect(filterButton("project-filter").getAttribute("aria-expanded")).toBe(
      "false"
    );
  });

  it("filters only its own panel's list", () => {
    renderPickers();
    act(() => filterButton("root-filter").click());
    act(() => filters["root-filter"].setStatus(new Set(["enabled"])));

    expect(rows("root-filter")).toEqual(["live"]);
    expect(rows("project-filter")).toEqual(["live", "off", "manual"]);
    expect(filterButton("root-filter").getAttribute("data-filtered")).toBe(
      "true"
    );
    expect(filterButton("project-filter").hasAttribute("data-filtered")).toBe(
      false
    );
  });

  it("narrows across the two menus", () => {
    renderPickers();
    act(() => filterButton("root-filter").click());
    act(() => {
      filters["root-filter"].setStatus(new Set(["disabled", "manual"]));
      filters["root-filter"].setTypes(new Set(["Event"]));
    });
    expect(rows("root-filter")).toEqual(["off"]);
  });

  it("clears and hides in one click while a filter is on", () => {
    renderPickers();
    act(() => filterButton("root-filter").click());
    act(() => filters["root-filter"].setTypes(new Set(["Manual"])));
    expect(rows("root-filter")).toEqual(["manual"]);

    act(() => filterButton("root-filter").click());
    expect(document.getElementById("root-filter")).toBeNull();
    expect(rows("root-filter")).toEqual(["live", "off", "manual"]);
  });

  it("hides an unused row on Escape but never drops picks", () => {
    renderPickers();
    act(() => filterButton("root-filter").click());
    act(() => filters["root-filter"].escape());
    expect(document.getElementById("root-filter")).toBeNull();

    act(() => filterButton("root-filter").click());
    act(() => filters["root-filter"].setStatus(new Set(["enabled"])));
    act(() => filters["root-filter"].escape());
    expect(document.getElementById("root-filter")).not.toBeNull();
    expect(rows("root-filter")).toEqual(["live"]);
  });

  it("keeps the row on reset and shows every workflow again", () => {
    renderPickers();
    act(() => filterButton("root-filter").click());
    act(() => filters["root-filter"].setStatus(new Set(["manual"])));
    act(() => filters["root-filter"].reset());
    expect(document.getElementById("root-filter")).not.toBeNull();
    expect(rows("root-filter")).toEqual(["live", "off", "manual"]);
    expect(document.activeElement).toBe(filterButton("root-filter"));
  });

  it("announces the count once the picks settle", () => {
    renderPickers();
    act(() => filterButton("root-filter").click());
    act(() => filters["root-filter"].setStatus(new Set(["enabled"])));
    act(() => vi.advanceTimersByTime(400));
    expect(
      panel("root-filter").querySelector("[aria-live=polite]")?.textContent
    ).toBe("1 of 3 workflows shown in root-filter");
  });

  it("names its panel, so two filter buttons can be told apart", () => {
    renderPickers();
    expect(filterButton("root-filter").getAttribute("aria-label")).toBe(
      "Filter root-filter"
    );
    expect(filterButton("project-filter").getAttribute("aria-label")).toBe(
      "Filter project-filter"
    );
  });

  it("drops the filter when its panel closes", () => {
    renderPickers();
    act(() => filterButton("root-filter").click());
    act(() => filters["root-filter"].setStatus(new Set(["enabled"])));
    renderPickers({ panelState: "collapsed" });
    expect(rows("root-filter")).toEqual(["live"]);

    renderPickers({ panelState: "closed" });
    expect(document.getElementById("root-filter")).toBeNull();
    expect(rows("root-filter")).toEqual(["live", "off", "manual"]);
  });

  it("is disabled with nothing to filter, but not while its row is open", () => {
    renderPickers({ list: [] });
    expect(filterButton("root-filter").disabled).toBe(true);

    renderPickers();
    act(() => filterButton("root-filter").click());
    act(() => filters["root-filter"].setStatus(new Set(["manual"])));
    // The last workflow moves out of the list; the leftover filter can
    // still be cleared from the button.
    renderPickers({ list: [] });
    const button = filterButton("root-filter");
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(document.getElementById("root-filter")).toBeNull();
    expect(filters["root-filter"].isFiltered).toBe(false);
  });

  it("returns the same list while no filter is on", () => {
    renderPickers();
    expect(applyPickerFilter(workflows, filters["root-filter"])).toBe(
      workflows
    );
  });
});
