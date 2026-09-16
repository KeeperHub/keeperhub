// @vitest-environment jsdom
/**
 * The gate's risk surface, per the review: what `PersistentCanvas` renders
 * either side of the breakpoint, whether a touch device is treated differently
 * from a narrow window, and which side of the gate the first client render (the
 * one before `useEffect` has measured) lands on.
 *
 * The canvas is stubbed. Everything else is the real component and the real hook.
 */
import type React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/workflows/demo",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

vi.mock("@/components/workflow/workflow-canvas", () => ({
  WorkflowCanvas: () => <div data-testid="workflow-canvas" />,
}));

import { PersistentCanvas } from "@/components/workflow/persistent-canvas";
import {
  EDITOR_OVERRIDE_KEY,
  requestEditorOnNarrowViewport,
  useEditorAvailability,
} from "@/hooks/use-editor-availability";

type Viewport = {
  width: number;
  coarse?: boolean;
  touch?: boolean;
  userAgent?: string;
};

const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

/**
 * Node 26 defines an unusable `localStorage` global, which stops jsdom from
 * installing its own. Replace it with real storage so the override path can be
 * exercised rather than silently skipped by the hook's try/catch.
 */
function stubStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => store.set(key, String(value)),
    },
  });
}

function stubViewport({
  width,
  coarse = false,
  touch = false,
  userAgent = DESKTOP_UA,
}: Viewport): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
    writable: true,
  });
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    value: touch ? 5 : 0,
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
  window.matchMedia = ((query: string) => ({
    matches: query.includes("pointer: coarse")
      ? coarse
      : query.includes("max-width: 767px") && width < 768,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function AvailabilityProbe(): React.ReactElement {
  return <span data-testid="availability">{useEditorAvailability()}</span>;
}

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  act(() => {
    // Let the gate's effect and its listeners settle.
  });
  return container;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  stubStorage();
  document.body.innerHTML = "";
  stubViewport({ width: 1440 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useEditorAvailability", () => {
  it("measures as unknown on the server render, before any effect runs", () => {
    // The first client render is this one. It must not read as available, or the
    // canvas and the run controls mount for a frame on a phone.
    expect(renderToStaticMarkup(<AvailabilityProbe />)).toContain("unknown");
  });

  it("treats a narrow touch device as unable to run the editor", () => {
    stubViewport({
      width: 767,
      coarse: true,
      touch: true,
      userAgent: PHONE_UA,
    });
    expect(render(<AvailabilityProbe />).textContent).toBe("unavailable");
  });

  it("keeps the editor for a narrow window on a desktop", () => {
    // 767px at 200% zoom on a 1366px laptop, which WCAG 1.4.4 covers.
    stubViewport({ width: 767, coarse: false, touch: false });
    expect(render(<AvailabilityProbe />).textContent).toBe("available");
  });

  it("keeps the editor for a wide touch device", () => {
    // An iPad in landscape or an iPhone Pro Max in landscape: touch, but room.
    stubViewport({
      width: 932,
      coarse: true,
      touch: true,
      userAgent: PHONE_UA,
    });
    expect(render(<AvailabilityProbe />).textContent).toBe("available");
  });

  it.each([
    [767, "unavailable"],
    [768, "available"],
  ])("measures a touch device at %ipx as %s", (width, expected) => {
    stubViewport({ width, coarse: true, touch: true, userAgent: PHONE_UA });
    expect(render(<AvailabilityProbe />).textContent).toBe(expected);
  });

  it("reads a mobile user agent on a narrow viewport as a phone even without touch points", () => {
    stubViewport({ width: 390, userAgent: PHONE_UA });
    expect(render(<AvailabilityProbe />).textContent).toBe("unavailable");
  });

  it("honours the escape hatch instead of reporting unavailable", () => {
    stubViewport({
      width: 390,
      coarse: true,
      touch: true,
      userAgent: PHONE_UA,
    });
    act(() => {
      requestEditorOnNarrowViewport();
    });
    expect(window.localStorage.getItem(EDITOR_OVERRIDE_KEY)).toBe("1");
    expect(render(<AvailabilityProbe />).textContent).toBe("available");
  });
});

describe("PersistentCanvas", () => {
  it("mounts no canvas before the gate has measured", () => {
    const markup = renderToStaticMarkup(<PersistentCanvas />);
    expect(markup).not.toContain("workflow-canvas");
  });

  it("mounts the canvas on a desktop", () => {
    stubViewport({ width: 1440 });
    expect(render(<PersistentCanvas />).innerHTML).toContain("workflow-canvas");
  });

  it("mounts the canvas in a narrow desktop window", () => {
    stubViewport({ width: 700 });
    expect(render(<PersistentCanvas />).innerHTML).toContain("workflow-canvas");
  });

  it("mounts no canvas on a phone", () => {
    stubViewport({
      width: 390,
      coarse: true,
      touch: true,
      userAgent: PHONE_UA,
    });
    expect(render(<PersistentCanvas />).innerHTML).not.toContain(
      "workflow-canvas"
    );
  });

  it("mounts the canvas on a phone once the escape hatch is used", () => {
    stubViewport({
      width: 390,
      coarse: true,
      touch: true,
      userAgent: PHONE_UA,
    });
    act(() => {
      requestEditorOnNarrowViewport();
    });
    expect(render(<PersistentCanvas />).innerHTML).toContain("workflow-canvas");
  });
});
