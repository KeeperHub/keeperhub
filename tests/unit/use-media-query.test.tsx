// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BELOW_LG_QUERY,
  BELOW_MD_QUERY,
  BELOW_SM_QUERY,
  mediaQueryMatches,
  useIsMobile,
  useMediaQuery,
} from "@/hooks/use-mobile";

let container: HTMLDivElement;
let root: Root;
let matches: boolean;
let listeners: Set<() => void>;
const addEventListener = vi.fn((_type: string, listener: () => void) => {
  listeners.add(listener);
});
const removeEventListener = vi.fn((_type: string, listener: () => void) => {
  listeners.delete(listener);
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let seen: boolean[] = [];

function Probe({ query }: { query: string }): null {
  seen.push(useMediaQuery(query));
  return null;
}

function render(query = "(width < 48rem)"): void {
  act(() => root.render(<Probe query={query} />));
}

// The screen crosses the query's boundary.
function change(next: boolean): void {
  matches = next;
  act(() => {
    for (const listener of listeners) {
      listener();
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  matches = true;
  listeners = new Set();
  seen = [];
  // As a real MediaQueryList: `matches` follows the screen.
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches(): boolean {
        return matches;
      },
      addEventListener,
      removeEventListener,
    }))
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("useMediaQuery", () => {
  it("is right from the first render on the client", () => {
    render();
    expect(seen[0]).toBe(true);
  });

  it("follows the screen across the boundary", () => {
    render();
    change(false);
    expect(seen.at(-1)).toBe(false);
    change(true);
    expect(seen.at(-1)).toBe(true);
  });

  it("answers right now from the hook's own list", () => {
    render();
    expect(mediaQueryMatches("(width < 48rem)")).toBe(true);
    change(false);
    expect(mediaQueryMatches("(width < 48rem)")).toBe(false);
    expect(window.matchMedia).toHaveBeenCalledOnce();
  });

  it("builds one list per query, however often it renders", () => {
    render();
    render();
    change(false);
    render();
    expect(window.matchMedia).toHaveBeenCalledOnce();
  });

  it("subscribes once, however often it renders", () => {
    render();
    render();
    render();
    expect(addEventListener).toHaveBeenCalledOnce();
    expect(removeEventListener).not.toHaveBeenCalled();
  });

  it("subscribes again for a new query, and lets go on unmount", () => {
    render("(width < 48rem)");
    render("(width < 64rem)");
    expect(addEventListener).toHaveBeenCalledTimes(2);
    expect(removeEventListener).toHaveBeenCalledOnce();
    act(() => root.unmount());
    root = createRoot(container);
    expect(listeners.size).toBe(0);
  });
});

// Tailwind's default breakpoints, which the queries must match.
function tailwindBreakpoint(name: string): string {
  const theme = readFileSync(
    createRequire(import.meta.url).resolve("tailwindcss/theme.css"),
    "utf8"
  );
  const value = new RegExp(`--breakpoint-${name}:\\s*([^;]+);`).exec(
    theme
  )?.[1];
  if (!value) {
    throw new Error(`no --breakpoint-${name} in Tailwind's theme`);
  }
  return value.trim();
}

describe("breakpoint queries", () => {
  it("match Tailwind's sm, md and lg", () => {
    expect(BELOW_SM_QUERY).toBe(`(width < ${tailwindBreakpoint("sm")})`);
    expect(BELOW_MD_QUERY).toBe(`(width < ${tailwindBreakpoint("md")})`);
    expect(BELOW_LG_QUERY).toBe(`(width < ${tailwindBreakpoint("lg")})`);
    function MobileProbe(): null {
      useIsMobile();
      return null;
    }
    act(() => root.render(<MobileProbe />));
    expect(window.matchMedia).toHaveBeenCalledWith(
      `(width < ${tailwindBreakpoint("md")})`
    );
  });
});
