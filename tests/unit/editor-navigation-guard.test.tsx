// @vitest-environment jsdom
import type React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

import { EditorNavigationGuard } from "@/components/editor-navigation-guard";

/**
 * Every root this file mounts, so it can be unmounted between cases. Clearing
 * `document.body` is not enough: a root left mounted keeps its capture-phase
 * listener, and the next case then measures a guard from the case before it,
 * which is the shape of a passing test that proves nothing.
 */
const mounted: (() => void)[] = [];

function mount(element: React.ReactElement): { unmount: () => void } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  const unmount = () => act(() => root.unmount());
  mounted.push(unmount);
  return { unmount };
}

type Viewport = { width: number; coarse?: boolean; userAgent?: string };

const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

const PHONE: Viewport = { width: 390, coarse: true, userAgent: PHONE_UA };
const EDITOR = "/workflows/5f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";

let viewport: Viewport = { width: 1440 };

/** Listeners registered against the stub, so a case can move the device. */
const mediaListeners = new Set<() => void>();

function fireMediaChange(): void {
  act(() => {
    for (const listener of mediaListeners) {
      listener();
    }
  });
}

function stubViewport(next: Viewport): void {
  viewport = next;
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: viewport.userAgent ?? DESKTOP_UA,
  });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("pointer: coarse")
      ? Boolean(viewport.coarse)
      : query.includes("max-width: 767px") && viewport.width < 768,
    media: query,
    onchange: null,
    addEventListener: (_type: string, cb: () => void) => {
      mediaListeners.add(cb);
    },
    removeEventListener: (_type: string, cb: () => void) => {
      mediaListeners.delete(cb);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Click the anchor in `markup` and report whether the navigation survived. */
function clickAnchor(
  markup: string,
  modifiers: MouseEventInit = {}
): MouseEvent {
  document.body.innerHTML = markup;
  const anchor = document.querySelector("a");
  if (anchor === null) {
    throw new Error("no anchor in the fixture");
  }
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...modifiers,
  });
  anchor.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  document.body.innerHTML = "";
  stubViewport({ width: 1440 });
});

afterEach(() => {
  for (const unmount of mounted.splice(0)) {
    unmount();
  }
  vi.restoreAllMocks();
});

describe("EditorNavigationGuard", () => {
  it("negates a tap on an editor link on a phone", () => {
    stubViewport(PHONE);
    mount(<EditorNavigationGuard />);

    const event = clickAnchor(`<a href="${EDITOR}">Open</a>`);

    expect(event.defaultPrevented).toBe(true);
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo.mock.calls[0][0]).toContain("desktop");
    // One id, so a second tap replaces the first rather than stacking.
    expect(toastInfo.mock.calls[0][1]).toMatchObject({
      id: "editor-desktop-only",
    });
  });

  it("negates it when the click lands on something inside the link", () => {
    stubViewport(PHONE);
    mount(<EditorNavigationGuard />);

    const event = clickAnchor(
      `<a href="${EDITOR}"><span id="glyph">Open</span></a>`
    );

    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves the create route and the list alone", () => {
    stubViewport(PHONE);
    mount(<EditorNavigationGuard />);

    // Both are reachable on a phone and neither is the editor.
    for (const href of ["/workflows/new", "/workflows", "/analytics", "/"]) {
      const event = clickAnchor(`<a href="${href}">Open</a>`);
      expect(event.defaultPrevented, href).toBe(false);
    }
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("leaves a link to another origin alone", () => {
    stubViewport(PHONE);
    mount(<EditorNavigationGuard />);

    const event = clickAnchor(
      `<a href="https://example.com${EDITOR}">Open</a>`
    );

    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves a modified click alone", () => {
    stubViewport(PHONE);
    mount(<EditorNavigationGuard />);

    for (const modifier of [
      "metaKey",
      "ctrlKey",
      "shiftKey",
      "altKey",
    ] as const) {
      const event = clickAnchor(`<a href="${EDITOR}">Open</a>`, {
        [modifier]: true,
      });
      expect(event.defaultPrevented, modifier).toBe(false);
    }
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("lets the click through on a desktop", () => {
    stubViewport({ width: 1440 });
    mount(<EditorNavigationGuard />);

    const event = clickAnchor(`<a href="${EDITOR}">Open</a>`);

    expect(event.defaultPrevented).toBe(false);
  });

  it("lets the click through on a narrow desktop window", () => {
    // The gate keeps the editor here, so the guard must not take the tap.
    stubViewport({ width: 700 });
    mount(<EditorNavigationGuard />);

    expect(clickAnchor(`<a href="${EDITOR}">Open</a>`).defaultPrevented).toBe(
      false
    );
  });

  it("installs nothing before the gate has measured", () => {
    // renderToStaticMarkup runs no effects, which is the first client render.
    stubViewport(PHONE);
    expect(renderToStaticMarkup(<EditorNavigationGuard />)).toBe("");

    expect(clickAnchor(`<a href="${EDITOR}">Open</a>`).defaultPrevented).toBe(
      false
    );
  });

  it("takes its listener down on unmount", () => {
    stubViewport(PHONE);
    const { unmount } = mount(<EditorNavigationGuard />);
    expect(clickAnchor(`<a href="${EDITOR}">Open</a>`).defaultPrevented).toBe(
      true
    );

    unmount();
    expect(clickAnchor(`<a href="${EDITOR}">Open</a>`).defaultPrevented).toBe(
      false
    );
  });

  it("rides a viewport that changes after mount", () => {
    // A rotated phone, or a window dragged narrower on a touch device: the guard
    // follows the gate rather than the mount, which is what makes it safe to
    // install app-wide for a device that may stop being a phone.
    stubViewport({ width: 1440 });
    mount(<EditorNavigationGuard />);
    expect(clickAnchor(`<a href="${EDITOR}">Open</a>`).defaultPrevented).toBe(
      false
    );

    stubViewport(PHONE);
    fireMediaChange();
    expect(clickAnchor(`<a href="${EDITOR}">Open</a>`).defaultPrevented).toBe(
      true
    );

    stubViewport({ width: 1440 });
    fireMediaChange();
    expect(clickAnchor(`<a href="${EDITOR}">Open</a>`).defaultPrevented).toBe(
      false
    );
  });
});
