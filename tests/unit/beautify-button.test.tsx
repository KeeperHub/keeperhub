// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BeautifyButton } from "@/components/workflow/config/beautify-button";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Partial<Parameters<typeof BeautifyButton>[0]> = {}): {
  onBeautify: ReturnType<typeof vi.fn>;
} {
  const onBeautify = vi.fn();
  act(() => {
    root.render(
      <BeautifyButton language="json" onBeautify={onBeautify} {...props} />
    );
  });
  return { onBeautify };
}

function button(): HTMLButtonElement {
  const found = container.querySelector("button");
  if (!found) {
    throw new Error("no button rendered");
  }
  return found;
}

describe("BeautifyButton", () => {
  it("renders one button carrying the label", () => {
    render();
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(button().textContent).toContain("Beautify");
  });

  it("fires when the label text is clicked", () => {
    const { onBeautify } = render();
    act(() => {
      button().click();
    });
    expect(onBeautify).toHaveBeenCalledTimes(1);
  });

  // The icon and the word are children of the same button, so a click on the
  // glyph has to reach the same handler - there is no second target.
  it("fires when the icon is clicked", () => {
    const { onBeautify } = render();
    const icon = button().querySelector("svg");
    expect(icon).not.toBeNull();
    act(() => {
      icon?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onBeautify).toHaveBeenCalledTimes(1);
  });

  it("does not fire while disabled", () => {
    const { onBeautify } = render({ disabled: true });
    expect(button().disabled).toBe(true);
    act(() => {
      button().click();
    });
    expect(onBeautify).not.toHaveBeenCalled();
  });

  it("does not fire while a previous run is pending", () => {
    const { onBeautify } = render({ pending: true });
    expect(button().disabled).toBe(true);
    act(() => {
      button().click();
    });
    expect(onBeautify).not.toHaveBeenCalled();
  });

  it("is a real button with an accessible name", () => {
    render();
    expect(button().tagName).toBe("BUTTON");
    expect(button().getAttribute("type")).toBe("button");
    expect(button().textContent?.trim()).toBe("Beautify");
  });
});
