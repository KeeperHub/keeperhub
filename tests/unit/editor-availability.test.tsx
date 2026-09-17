// @vitest-environment jsdom
/**
 * The gate's risk surface, per the review: what `PersistentCanvas` renders
 * either side of the breakpoint, which device signals the gate reads, which side
 * of it the first client render (before `useEffect` has measured) lands on, and
 * what happens when the environment changes after mount.
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
  isEditorPath,
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

const PHONE_VIEWPORT: Viewport = {
  width: 390,
  coarse: true,
  userAgent: PHONE_UA,
};

/**
 * Node 26 defines unusable `localStorage` and `sessionStorage` globals, which
 * stop jsdom installing its own. Replace both with real storage so the override
 * path is exercised rather than skipped by the hook's try/catch.
 */
function memoryStore(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  } as Storage;
}

function stubStorage(): void {
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: memoryStore(),
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: memoryStore(),
  });
}

/** The viewport the stub below reports, mutable so a case can move it. */
let viewport: Viewport = { width: 1440 };

/** Listeners registered against the stub, keyed by query, so cases can fire and
 *  count them: the resize path and the cleanup are both reachable this way. */
const mediaListeners = new Map<string, Set<() => void>>();

function stubViewport(next: Viewport): void {
  viewport = { ...next };
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    value: viewport.touch ? 5 : 0,
  });
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
      const set = mediaListeners.get(query) ?? new Set();
      set.add(cb);
      mediaListeners.set(query, set);
    },
    removeEventListener: (_type: string, cb: () => void) => {
      mediaListeners.get(query)?.delete(cb);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function resize(next: Viewport): void {
  stubViewport({ ...viewport, ...next });
}

function mediaListenerCount(): number {
  let total = 0;
  for (const set of mediaListeners.values()) {
    total += set.size;
  }
  return total;
}

function fireMediaChange(queryFragment: string): void {
  for (const [query, set] of mediaListeners) {
    if (query.includes(queryFragment)) {
      for (const cb of set) {
        cb();
      }
    }
  }
}

function AvailabilityProbe(): React.ReactElement {
  return <span data-testid="availability">{useEditorAvailability()}</span>;
}

function mount(element: React.ReactElement): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

function render(element: React.ReactElement): HTMLElement {
  return mount(element).container;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  stubStorage();
  mediaListeners.clear();
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
    stubViewport({ ...PHONE_VIEWPORT, width: 767 });
    expect(render(<AvailabilityProbe />).textContent).toBe("unavailable");
  });

  it("keeps the editor for a narrow window on a desktop", () => {
    // 767px at 200% zoom on a 1366px laptop, which WCAG 1.4.4 covers.
    stubViewport({ width: 767, coarse: false, touch: false });
    expect(render(<AvailabilityProbe />).textContent).toBe("available");
  });

  it("keeps the editor on a narrow touchscreen laptop whose pointer is fine", () => {
    // The review's third blocker, isolated: a touchscreen Windows laptop reports
    // ten touch points with `pointer: fine`, because `pointer` describes the
    // primary input and that is the trackpad. A disjunct on maxTouchPoints reads
    // the zoomed-laptop case as a phone and withdraws the editor from it.
    stubViewport({ width: 700, coarse: false, touch: true });
    expect(render(<AvailabilityProbe />).textContent).toBe("available");
  });

  it("keeps the editor for a wide touch device", () => {
    // An iPad in landscape or an iPhone Pro Max in landscape: touch, but room.
    stubViewport({ ...PHONE_VIEWPORT, width: 932 });
    expect(render(<AvailabilityProbe />).textContent).toBe("available");
  });

  it.each([
    [767, "unavailable"],
    [768, "available"],
  ])("measures a phone at %ipx as %s", (width, expected) => {
    stubViewport({ ...PHONE_VIEWPORT, width });
    expect(render(<AvailabilityProbe />).textContent).toBe(expected);
  });

  it("reads a mobile user agent on a narrow viewport as a phone even without a coarse pointer", () => {
    stubViewport({ width: 390, userAgent: PHONE_UA });
    expect(render(<AvailabilityProbe />).textContent).toBe("unavailable");
  });

  it("re-measures when the viewport changes after mount", () => {
    // A phone rotating to landscape: 932px is not narrow, so the editor is back.
    stubViewport({ ...PHONE_VIEWPORT, width: 767 });
    const { container } = mount(<AvailabilityProbe />);
    expect(container.textContent).toBe("unavailable");

    resize({ width: 932 });
    act(() => {
      fireMediaChange("max-width: 767px");
    });
    expect(container.textContent).toBe("available");

    resize({ width: 500 });
    act(() => {
      fireMediaChange("max-width: 767px");
    });
    expect(container.textContent).toBe("unavailable");
  });

  it("releases every listener it registered", () => {
    stubViewport(PHONE_VIEWPORT);
    const { unmount } = mount(<AvailabilityProbe />);
    expect(mediaListenerCount()).toBeGreaterThan(0);
    const before = mediaListenerCount();
    unmount();
    expect(mediaListenerCount()).toBeLessThan(before);
  });

  it("stays unavailable on a phone, with no way in from the page", () => {
    // The product decision, as a test: switching the browser to desktop mode is
    // the way through, so nothing here can flip this device back to available.
    stubViewport(PHONE_VIEWPORT);
    const { container } = mount(<AvailabilityProbe />);
    expect(container.textContent).toBe("unavailable");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      window.dispatchEvent(new Event("resize"));
    });
    expect(container.textContent).toBe("unavailable");
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("isEditorPath", () => {
  it("names the editor route", () => {
    expect(
      isEditorPath("/workflows/5f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8")
    ).toBe(true);
    expect(isEditorPath("/workflows/5f1a2b3c/")).toBe(true);
  });

  it("leaves the list and the create route alone", () => {
    // Both are reachable on a phone and neither is the editor.
    expect(isEditorPath("/workflows")).toBe(false);
    expect(isEditorPath("/workflows/new")).toBe(false);
    expect(isEditorPath("/workflows/new/")).toBe(false);
  });

  it("leaves every other route alone", () => {
    for (const path of [
      "/",
      "/analytics",
      "/executions/abc",
      "/workflows/abc/runs",
      "/settings/hub",
    ]) {
      expect(isEditorPath(path)).toBe(false);
    }
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

  it("mounts the canvas on a narrow touchscreen laptop with a fine pointer", () => {
    stubViewport({ width: 700, coarse: false, touch: true });
    expect(render(<PersistentCanvas />).innerHTML).toContain("workflow-canvas");
  });

  it("mounts no canvas on a phone", () => {
    stubViewport(PHONE_VIEWPORT);
    expect(render(<PersistentCanvas />).innerHTML).not.toContain(
      "workflow-canvas"
    );
  });
});
