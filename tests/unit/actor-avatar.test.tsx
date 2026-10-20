// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Actor, ActorAvatar } from "@/components/activity/actor-avatar";

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function shownInitials(actor: Actor | null): string | undefined {
  act(() => root.render(<ActorAvatar actor={actor} />));
  return container.textContent ?? undefined;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ActorAvatar", () => {
  it("shows a name's initials as the rest of the app does", () => {
    // The first two words, as the org switcher and the user menu.
    expect(shownInitials({ name: "Mary Jane Smith" })).toBe("MJ");
  });

  it("falls back to the email's first character", () => {
    expect(shownInitials({ name: " ", email: "jo@example.com" })).toBe("J");
  });
});
