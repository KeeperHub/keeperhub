// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  isEscapeFromOverlay,
  isEscapeHandled,
  markEscapeHandled,
} from "@/lib/escape-key";

afterEach(() => {
  document.body.innerHTML = "";
});

function escapeFrom(target: Element): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  target.dispatchEvent(event);
  return event;
}

describe("handled Escapes", () => {
  it("remembers only the event that was marked", () => {
    const marked = new KeyboardEvent("keydown", { key: "Escape" });
    markEscapeHandled(marked);
    expect(isEscapeHandled(marked)).toBe(true);
    expect(isEscapeHandled(new KeyboardEvent("keydown"))).toBe(false);
  });
});

describe("isEscapeFromOverlay", () => {
  it.each(["dialog", "alertdialog", "menu", "listbox"])(
    "is true from inside a %s",
    (role) => {
      document.body.innerHTML = `<div role="${role}"><button>x</button></div>`;
      const button = document.querySelector("button");
      expect(button && isEscapeFromOverlay(escapeFrom(button))).toBe(true);
    }
  );

  it("is still true once the overlay has left the page", () => {
    document.body.innerHTML = `<div role="listbox"><div role="option">a</div></div>`;
    const option = document.querySelector("[role=option]");
    if (!option) {
      throw new Error("no option");
    }
    const event = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(event, "target", { value: option });
    document.querySelector("[role=listbox]")?.remove();
    expect(isEscapeFromOverlay(event)).toBe(true);
  });

  it("is false from the sidebar panel or the page", () => {
    document.body.innerHTML = `<section aria-label="Workflows"><button>row</button></section>`;
    const button = document.querySelector("button");
    expect(button && isEscapeFromOverlay(escapeFrom(button))).toBe(false);
    expect(isEscapeFromOverlay(escapeFrom(document.body))).toBe(false);
  });
});
