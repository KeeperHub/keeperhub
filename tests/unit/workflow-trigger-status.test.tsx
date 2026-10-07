// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTriggerIcon,
  TRIGGER_ICONS,
} from "@/components/workflow-trigger-icons";
import {
  TriggerFilterButton,
  TriggerFilterChips,
  TriggerStatusIcon,
} from "@/components/workflow-trigger-status";
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
    render(<TriggerFilterButton onToggle={onToggle} open={false} />);
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.getAttribute("aria-label")).toBe("Filter and search");
    act(() => button?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);

    render(<TriggerFilterButton onToggle={onToggle} open />);
    expect(button?.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("TriggerFilterButton while loading", () => {
  it("is disabled and ignores clicks", () => {
    const onToggle = vi.fn();
    render(<TriggerFilterButton disabled onToggle={onToggle} open={false} />);
    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
    act(() => button?.click());
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("TriggerFilterChips", () => {
  const counts = { all: 11, enabled: 5, disabled: 5, manual: 1 };

  const renderChips = (
    value: ReadonlySet<"enabled" | "disabled" | "manual">,
    handlers: { onToggle?: () => void; onClear?: () => void } = {}
  ): void =>
    render(
      <TriggerFilterChips
        counts={counts}
        onClear={handlers.onClear ?? vi.fn()}
        onToggle={handlers.onToggle ?? vi.fn()}
        value={value}
      />
    );
  const pressed = (): (string | null)[] =>
    [...container.querySelectorAll("button")].map((chip) =>
      chip.getAttribute("aria-pressed")
    );

  it("shows a chip per filter with its count, the picked one pressed", () => {
    renderChips(new Set(["disabled"]));
    const chips = [...container.querySelectorAll("button")];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "All 11",
      "Enabled 5",
      "Disabled 5",
      "Manual 1",
    ]);
    expect(pressed()).toEqual(["false", "false", "true", "false"]);
  });

  it("presses All while nothing else is picked", () => {
    renderChips(new Set());
    expect(pressed()).toEqual(["true", "false", "false", "false"]);
  });

  it("presses every picked chip at once", () => {
    renderChips(new Set(["enabled", "disabled"]));
    expect(pressed()).toEqual(["false", "true", "true", "false"]);
  });

  it("toggles a status chip and clears with All", () => {
    const onToggle = vi.fn();
    const onClear = vi.fn();
    renderChips(new Set(["enabled"]), { onToggle, onClear });
    act(() =>
      container
        .querySelector<HTMLButtonElement>("[data-filter=manual]")
        ?.click()
    );
    expect(onToggle).toHaveBeenCalledWith("manual");
    act(() =>
      container.querySelector<HTMLButtonElement>("[data-filter=all]")?.click()
    );
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("dims a chip that would empty the list, unless it is picked", () => {
    const zero = { all: 34, enabled: 0, disabled: 30, manual: 4 };
    act(() =>
      root.render(
        <TriggerFilterChips
          counts={zero}
          onClear={vi.fn()}
          onToggle={vi.fn()}
          value={new Set()}
        />
      )
    );
    const enabled = container.querySelector("[data-filter=enabled]");
    expect(enabled?.className).toContain("opacity-70");
    expect(
      container.querySelector("[data-filter=disabled]")?.className
    ).not.toContain("opacity-70");

    act(() =>
      root.render(
        <TriggerFilterChips
          counts={zero}
          onClear={vi.fn()}
          onToggle={vi.fn()}
          value={new Set(["enabled"])}
        />
      )
    );
    expect(
      container.querySelector("[data-filter=enabled]")?.className
    ).not.toContain("opacity-70");
  });

  it("says on the Disabled chip how many are deactivated", () => {
    act(() =>
      root.render(
        <TriggerFilterChips
          counts={counts}
          deactivatedCount={2}
          onClear={vi.fn()}
          onToggle={vi.fn()}
          value={new Set()}
        />
      )
    );
    expect(
      container.querySelector("[data-filter=disabled]")?.textContent
    ).toContain("Includes 2 deactivated by KeeperHub");
    expect(container.querySelector("[data-filter=enabled]")?.textContent).toBe(
      "Enabled 5"
    );
  });

  it("closes the filter on Escape from a chip", () => {
    const onEscape = vi.fn();
    act(() =>
      root.render(
        <TriggerFilterChips
          counts={counts}
          onClear={vi.fn()}
          onEscape={onEscape}
          onToggle={vi.fn()}
          value={new Set()}
        />
      )
    );
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      container.querySelector("[data-filter=manual]")?.dispatchEvent(event);
    });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
