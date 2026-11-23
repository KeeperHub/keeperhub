// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TagsPanel,
  type WorkflowEntry,
  WorkflowItem,
} from "@/components/workflow-picker-list";
import { TOOLTIP_DELAY_MS } from "@/components/workflow-trigger-status";
import type { Tag } from "@/lib/api-client";
import { isEscapeHandled } from "@/lib/escape-key";
import { describeDeactivation } from "@/lib/workflow/trigger-display";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
  // Radix measures a tooltip's trigger with an observer jsdom does not have.
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
  vi.restoreAllMocks();
});

function render(node: React.ReactNode): void {
  act(() => root.render(node));
}

const base: WorkflowEntry = {
  id: "w1",
  name: "Hat monitor",
  updatedAt: "2026-10-01T00:00:00.000Z",
  triggerType: "Schedule",
  triggerConfig: { scheduleCron: "*/5 * * * *" },
  enabled: false,
};

function row(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    "[data-testid=workflow-picker-item]"
  );
  if (!button) {
    throw new Error("no row");
  }
  return button;
}

// The visible tooltip, not Radix's hidden copy for screen readers.
function tooltipText(): string | null {
  const content = document.querySelector("[data-radix-popper-content-wrapper]");
  return content?.firstElementChild?.textContent ?? null;
}

// jsdom's own guess at :focus-visible changes from test to test, so a test
// says which kind of focus it means.
function keyboardFocus(element: HTMLElement, visible = true): void {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector: string
  ) {
    return selector === ":focus-visible"
      ? visible
      : matches.call(this, selector);
  });
  act(() => element.focus());
}

function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function pressEscape(target: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("WorkflowItem keyboard-focus tooltip", () => {
  it("opens after the hover delay on a deactivated row, with the reason", () => {
    render(
      <WorkflowItem
        activeWorkflowId={undefined}
        workflow={{ ...base, deactivatedAt: "2026-10-01T00:00:00.000Z" }}
      />
    );
    keyboardFocus(row());
    wait(TOOLTIP_DELAY_MS - 1);
    expect(tooltipText()).toBeNull();
    wait(1);
    expect(tooltipText()).toBe(
      `${describeDeactivation("2026-10-01T00:00:00.000Z")}Deactivated · Schedule trigger · Every 5 minutes`
    );
  });

  it("stays shut on a row with nothing the row does not already show", () => {
    render(<WorkflowItem activeWorkflowId={undefined} workflow={base} />);
    keyboardFocus(row());
    wait(TOOLTIP_DELAY_MS);
    expect(tooltipText()).toBeNull();
  });

  it("shows a cut-off name in full", () => {
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(300);
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(100);
    render(<WorkflowItem activeWorkflowId={undefined} workflow={base} />);
    keyboardFocus(row());
    wait(TOOLTIP_DELAY_MS);
    expect(tooltipText()).toBe(
      "Hat monitorDisabled · Schedule trigger · Every 5 minutes"
    );
  });

  it("does not open for focus that came from a click", () => {
    render(
      <WorkflowItem
        activeWorkflowId={undefined}
        workflow={{ ...base, deactivatedAt: "2026-10-01T00:00:00.000Z" }}
      />
    );
    keyboardFocus(row(), false);
    wait(TOOLTIP_DELAY_MS);
    expect(tooltipText()).toBeNull();
  });

  it("closes on Escape, and keeps that Escape from closing the panel", () => {
    render(
      <WorkflowItem
        activeWorkflowId={undefined}
        workflow={{ ...base, deactivatedAt: "2026-10-01T00:00:00.000Z" }}
      />
    );
    keyboardFocus(row());
    wait(TOOLTIP_DELAY_MS);
    expect(tooltipText()).not.toBeNull();
    const event = pressEscape(row());
    expect(tooltipText()).toBeNull();
    expect(isEscapeHandled(event)).toBe(true);
    // With the tooltip shut, the next Escape is the panel's.
    expect(isEscapeHandled(pressEscape(row()))).toBe(false);
  });

  it("closes when the mouse moves, so it never sits beside a hover tooltip", () => {
    render(
      <WorkflowItem
        activeWorkflowId={undefined}
        workflow={{ ...base, deactivatedAt: "2026-10-01T00:00:00.000Z" }}
      />
    );
    keyboardFocus(row());
    wait(TOOLTIP_DELAY_MS);
    act(() => {
      document.dispatchEvent(new Event("pointermove"));
    });
    expect(tooltipText()).toBeNull();
  });

  it("does not open when focus leaves before the delay", () => {
    render(
      <WorkflowItem
        activeWorkflowId={undefined}
        workflow={{ ...base, deactivatedAt: "2026-10-01T00:00:00.000Z" }}
      />
    );
    keyboardFocus(row());
    act(() => row().blur());
    wait(TOOLTIP_DELAY_MS);
    expect(tooltipText()).toBeNull();
  });
});

describe("TagsPanel while filtering", () => {
  const tag = {
    id: "t1",
    name: "Monitors",
    color: "#fff",
    workflowCount: 1,
  } as Tag;

  function renderPanel(expandAll: boolean): void {
    render(
      <TagsPanel
        activeWorkflowId={undefined}
        expandAll={expandAll}
        loading={false}
        projectTags={[tag]}
        untaggedWorkflows={[{ ...base, id: "w2", name: "Loose" }]}
        workflowsByTagId={{ t1: [base] }}
      />
    );
  }

  function headers(): HTMLElement[] {
    return [
      ...container.querySelectorAll<HTMLElement>(
        "[data-testid=tag-group-header]"
      ),
    ];
  }

  it("folds a group from its header when nothing is filtered", () => {
    renderPanel(false);
    const [tagHeader] = headers();
    expect(tagHeader.getAttribute("aria-expanded")).toBe("true");
    act(() => tagHeader.click());
    expect(tagHeader.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Hat monitor");
  });

  it("holds every group open, with plain-text headers and no chevrons", () => {
    renderPanel(false);
    act(() => headers()[0].click());
    renderPanel(true);
    // The group folded a moment ago shows its match.
    expect(container.textContent).toContain("Hat monitor");
    for (const header of headers()) {
      // Not a button at all, so it is not read as a dimmed control.
      expect(header.tagName).toBe("DIV");
      expect(header.hasAttribute("aria-expanded")).toBe(false);
      expect(header.querySelector("svg")).toBeNull();
    }
    expect(headers()).toHaveLength(2);
  });
});
