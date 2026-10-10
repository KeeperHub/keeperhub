// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTriggerIcon,
  TRIGGER_ICONS,
} from "@/components/workflow-trigger-icons";
import {
  MENU_HOVER_CLOSE_MS,
  MENU_HOVER_OPEN_MS,
  TriggerFilterButton,
  TriggerFilters,
  TriggerStatusIcon,
} from "@/components/workflow-trigger-status";
import { isEscapeHandled } from "@/lib/escape-key";
import { WorkflowTriggerEnum } from "@/lib/workflow/store";

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode): void {
  act(() => root.render(node));
}

describe("trigger icons", () => {
  it("has an icon for every trigger type", () => {
    for (const trigger of Object.values(WorkflowTriggerEnum)) {
      expect(TRIGGER_ICONS[trigger]).toBeDefined();
    }
  });

  it("draws the clock for the legacy Scheduled spelling", () => {
    expect(getTriggerIcon("Scheduled")).toBe(TRIGGER_ICONS.Schedule);
  });

  it("falls back to the Manual icon for an unknown or missing type", () => {
    expect(getTriggerIcon("Nope")).toBe(TRIGGER_ICONS.Manual);
    expect(getTriggerIcon(undefined)).toBe(TRIGGER_ICONS.Manual);
  });
});

describe("TriggerStatusIcon", () => {
  it("is green only when enabled", () => {
    render(<TriggerStatusIcon status="enabled" triggerType="Schedule" />);
    const icon = container.querySelector("[data-testid=trigger-status-icon]");
    expect(icon?.getAttribute("data-trigger-status")).toBe("enabled");
    expect(icon?.getAttribute("data-trigger-type")).toBe("Schedule");
    expect(icon?.className).not.toContain("text-muted-foreground");
  });

  it.each(["disabled", "manual"] as const)("is grey when %s", (status) => {
    render(<TriggerStatusIcon status={status} triggerType="Manual" />);
    const icon = container.querySelector("[data-testid=trigger-status-icon]");
    expect(icon?.className).toContain("text-muted-foreground");
    expect(icon?.className).not.toContain("keeperhub-green");
  });

  it("reports Manual when no trigger is configured", () => {
    render(<TriggerStatusIcon status="manual" triggerType={undefined} />);
    expect(
      container
        .querySelector("[data-testid=trigger-status-icon]")
        ?.getAttribute("data-trigger-type")
    ).toBe("Manual");
  });
});

describe("TriggerFilterButton", () => {
  it("reflects and toggles its open state", () => {
    const onToggle = vi.fn();
    render(
      <TriggerFilterButton
        controls="filter-row"
        onToggle={onToggle}
        open={false}
        panelName="Workflows"
      />
    );
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.getAttribute("aria-label")).toBe("Filter Workflows");
    act(() => button?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);

    render(
      <TriggerFilterButton
        controls="filter-row"
        onToggle={onToggle}
        open
        panelName="Workflows"
      />
    );
    expect(button?.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows a dot while a filter is on, and still acts when clicked", () => {
    const onToggle = vi.fn();
    render(
      <TriggerFilterButton
        controls="filter-row"
        filtered
        onToggle={onToggle}
        open
        panelName="Workflows"
      />
    );
    const button = container.querySelector("button");
    // Never a dead control: the sidebar makes this click clear and hide.
    expect(button?.hasAttribute("aria-disabled")).toBe(false);
    expect(button?.getAttribute("aria-label")).toBe(
      "Filter Workflows, filters on"
    );
    expect(button?.querySelector("span[aria-hidden=true]")).not.toBeNull();
    act(() => button?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("TriggerFilterButton while loading", () => {
  it("is disabled and ignores clicks", () => {
    const onToggle = vi.fn();
    render(
      <TriggerFilterButton
        controls="filter-row"
        disabled
        onToggle={onToggle}
        open={false}
        panelName="Workflows"
      />
    );
    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
    act(() => button?.click());
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("TriggerFilters", () => {
  const statusCounts = { enabled: 5, disabled: 5, manual: 1 };
  const typeCounts = {
    Schedule: 6,
    Event: 3,
    Block: 0,
    Webhook: 1,
    Transfer: 0,
    "Pyth Price": 0,
    Manual: 1,
  };
  const listedTypes = [
    WorkflowTriggerEnum.SCHEDULE,
    WorkflowTriggerEnum.EVENT,
    WorkflowTriggerEnum.BLOCK,
    WorkflowTriggerEnum.WEBHOOK,
    WorkflowTriggerEnum.TEMPO_PAYMENT,
    WorkflowTriggerEnum.MANUAL,
  ];

  beforeEach(() => {
    // Radix measures the menu's trigger with an observer jsdom does not have.
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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  type Props = Partial<React.ComponentProps<typeof TriggerFilters>>;
  function renderFilters(props: Props = {}): void {
    render(
      <TriggerFilters
        listedTypes={listedTypes}
        onClearAll={vi.fn()}
        onClearStatus={vi.fn()}
        onClearTypes={vi.fn()}
        onToggleStatus={vi.fn()}
        onToggleType={vi.fn()}
        status={new Set()}
        statusCounts={statusCounts}
        typeCounts={typeCounts}
        types={new Set()}
        {...props}
      />
    );
  }

  function button(testId: string): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>(
      `[data-testid=${testId}]`
    );
    if (!found) {
      throw new Error(`no ${testId}`);
    }
    return found;
  }

  function press(target: Element, key: string): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function menuItems(): HTMLElement[] {
    return [
      ...document.querySelectorAll<HTMLElement>("[role=menuitemcheckbox]"),
    ];
  }

  function pointer(target: Element, type: string): void {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    act(() => {
      target.dispatchEvent(event);
    });
  }

  it("reads All on both buttons while nothing is picked, with no clear", () => {
    renderFilters();
    expect(button("status-filter").textContent).toBe("StatusAll");
    expect(button("trigger-type-filter").textContent).toBe("TriggerAll");
    expect(button("status-filter").getAttribute("aria-label")).toBe(
      "Status: All"
    );
    expect(
      container.querySelector("[data-testid=trigger-filter-clear]")
    ).toBeNull();
  });

  it("names the first pick and how many more, and offers to clear both", () => {
    const onClearAll = vi.fn();
    renderFilters({
      status: new Set(["enabled"]),
      types: new Set([WorkflowTriggerEnum.EVENT, WorkflowTriggerEnum.BLOCK]),
      onClearAll,
    });
    expect(button("status-filter").textContent).toBe("Enabled");
    expect(button("trigger-type-filter").textContent).toBe("Event+1");
    expect(button("trigger-type-filter").getAttribute("aria-label")).toBe(
      "Trigger: Event, Block"
    );
    act(() => button("trigger-filter-clear").click());
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("lists the statuses with counts and the deactivated note", () => {
    renderFilters({ deactivatedCount: 2 });
    press(button("status-filter"), "Enter");
    expect(menuItems().map((item) => item.textContent)).toEqual([
      "Enabled5",
      "DisabledIncl. 2 deactivated5",
      "Manual1",
    ]);
  });

  it("lists every trigger type with its row icon, dimming the empty ones", () => {
    renderFilters();
    press(button("trigger-type-filter"), "Enter");
    const items = menuItems();
    expect(items.map((item) => item.dataset.filter)).toEqual(listedTypes);
    expect(items.map((item) => item.textContent)).toEqual([
      "Schedule6",
      "Event3",
      "Block0",
      "Webhook1",
      "Transfer0",
      "Manual1",
    ]);
    // The icon is the row's tile, grey: green would read as a status.
    expect(items[0].querySelector("svg.lucide-clock")).not.toBeNull();
    // Block has none: its name dims, but not its zero, which is the point.
    expect(items[2].querySelector(".opacity-60")?.textContent).toBe("Block");
    expect(items[0].querySelector(".opacity-60")).toBeNull();
  });

  it("toggles a pick and stays open for the next one", () => {
    const onToggleType = vi.fn();
    renderFilters({ onToggleType });
    press(button("trigger-type-filter"), "Enter");
    act(() => menuItems()[1].click());
    expect(onToggleType).toHaveBeenCalledWith(WorkflowTriggerEnum.EVENT);
    expect(menuItems()).toHaveLength(6);
  });

  it("opens on hover after a short rest and closes after the pointer leaves", () => {
    vi.useFakeTimers();
    renderFilters();
    const trigger = button("trigger-type-filter");
    pointer(trigger, "pointerover");
    act(() => {
      vi.advanceTimersByTime(MENU_HOVER_OPEN_MS - 1);
    });
    expect(menuItems()).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(menuItems()).toHaveLength(6);
    // Opened by hover, it leaves focus where it was.
    expect(document.activeElement).toBe(document.body);
    pointer(trigger, "pointerout");
    act(() => {
      vi.advanceTimersByTime(MENU_HOVER_CLOSE_MS);
    });
    expect(menuItems()).toHaveLength(0);
  });

  it("opens nothing when the pointer only passes over", () => {
    vi.useFakeTimers();
    renderFilters();
    const trigger = button("status-filter");
    pointer(trigger, "pointerover");
    pointer(trigger, "pointerout");
    act(() => {
      vi.advanceTimersByTime(MENU_HOVER_OPEN_MS * 2);
    });
    expect(menuItems()).toHaveLength(0);
  });

  it("closes a hover-opened menu on Escape and marks it used", () => {
    vi.useFakeTimers();
    const onEscape = vi.fn();
    renderFilters({ onEscape });
    const trigger = button("status-filter");
    act(() => trigger.focus());
    pointer(trigger, "pointerover");
    act(() => {
      vi.advanceTimersByTime(MENU_HOVER_OPEN_MS);
    });
    expect(menuItems()).toHaveLength(3);
    // Focus is still on the button; the menu's Escape must not also reach
    // the button's own handler or the sidebar's.
    const event = press(trigger, "Escape");
    expect(menuItems()).toHaveLength(0);
    expect(isEscapeHandled(event)).toBe(true);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("opens one menu at a time, switching on hover while one is open", () => {
    renderFilters();
    press(button("status-filter"), "Enter");
    expect(document.querySelector("[data-filter-menu=status]")).not.toBeNull();
    pointer(button("trigger-type-filter"), "pointerover");
    expect(document.querySelector("[data-filter-menu=status]")).toBeNull();
    expect(document.querySelector("[data-filter-menu=trigger]")).not.toBeNull();
  });

  it("gives focus back when a hover-opened menu closes from under it", () => {
    vi.useFakeTimers();
    renderFilters();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => outside.focus());
    const trigger = button("trigger-type-filter");
    pointer(trigger, "pointerover");
    act(() => {
      vi.advanceTimersByTime(MENU_HOVER_OPEN_MS);
    });
    expect(document.activeElement).toBe(outside);
    // The pointer crossing the items moves focus onto them.
    act(() => menuItems()[0].focus());
    pointer(trigger, "pointerout");
    act(() => {
      vi.advanceTimersByTime(MENU_HOVER_CLOSE_MS);
    });
    // Radix hands focus back a tick after the menu unmounts.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("moves into a hover-opened menu on the down arrow", () => {
    vi.useFakeTimers();
    renderFilters();
    const trigger = button("trigger-type-filter");
    act(() => trigger.focus());
    pointer(trigger, "pointerover");
    act(() => {
      vi.advanceTimersByTime(MENU_HOVER_OPEN_MS);
    });
    press(trigger, "ArrowDown");
    expect(document.activeElement).toBe(menuItems()[0]);
  });

  it("steps the filter back on Escape from a shut menu's button", () => {
    const onEscape = vi.fn();
    renderFilters({ onEscape });
    const event = press(button("status-filter"), "Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(isEscapeHandled(event)).toBe(true);
  });
});
