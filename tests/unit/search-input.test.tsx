// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchInput } from "@/components/ui/search-input";

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

function renderSearch(
  value: string,
  onValueChange = vi.fn()
): HTMLInputElement {
  act(() =>
    root.render(
      <SearchInput
        aria-label="Search"
        onValueChange={onValueChange}
        value={value}
      />
    )
  );
  const input = container.querySelector("input");
  if (!input) {
    throw new Error("no input rendered");
  }
  return input;
}

function pressEscape(input: HTMLInputElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    input.dispatchEvent(event);
  });
  return event;
}

describe("SearchInput", () => {
  it("shows the clear button only while there is text", () => {
    renderSearch("");
    expect(container.querySelector('[aria-label="Clear search"]')).toBeNull();
    renderSearch("pause");
    expect(
      container.querySelector('[aria-label="Clear search"]')
    ).not.toBeNull();
  });

  it("clears the text with the clear button", () => {
    const onValueChange = vi.fn();
    renderSearch("pause", onValueChange);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Clear search"]')
        ?.click()
    );
    expect(onValueChange).toHaveBeenCalledWith("");
  });

  it("clears a typed query on Escape and stops it there", () => {
    const onValueChange = vi.fn();
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    const event = pressEscape(renderSearch("pause", onValueChange));
    document.removeEventListener("keydown", outside);
    expect(onValueChange).toHaveBeenCalledWith("");
    expect(event.defaultPrevented).toBe(true);
    expect(outside).not.toHaveBeenCalled();
  });

  it("lets Escape through when the field is already empty", () => {
    const onValueChange = vi.fn();
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    pressEscape(renderSearch("", onValueChange));
    document.removeEventListener("keydown", outside);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(outside).toHaveBeenCalledTimes(1);
  });
});
