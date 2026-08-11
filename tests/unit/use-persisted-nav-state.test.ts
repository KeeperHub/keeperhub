// @vitest-environment jsdom

// Fallback path: this codebase does not depend on @testing-library/react, so
// we cannot render the hook to test it. Instead we test the underlying
// loadState/persistState helpers via test-only exports
// (__loadStateForTesting / __persistStateForTesting). The exports are clearly
// suffixed with _FOR_TESTING and live alongside the hook in
// lib/hooks/use-persisted-nav-state.ts. See plan 42-04 SUMMARY for context;
// plan 42-06's executor should NOT remove these exports.
//
// KEEP-450: VERSION bumped from 3 -> 4 when the navigation cascade was
// flattened (Tags as subheaders inside the Projects panel; the third-level
// Workflows panel was removed). Existing v3 snapshots are discarded on
// hydration so stale `panels.workflows` / `selectedTagId` cannot leak into
// the new layout.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __DEFAULT_STATE_FOR_TESTING as DEFAULT_STATE,
  __loadStateForTesting as loadState,
  __persistStateForTesting as persistState,
  __STORAGE_KEY_FOR_TESTING as STORAGE_KEY,
  __VERSION_FOR_TESTING as VERSION,
} from "@/lib/hooks/use-persisted-nav-state";

describe("usePersistedNavState (NAV-07 + HUB-25)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("returns DEFAULT_STATE when localStorage is empty", () => {
    const result = loadState();
    expect(result).toEqual(DEFAULT_STATE);
    expect(result.version).toBe(VERSION);
    expect(result.sidebar).toBe(true);
    expect(result.panels.projects).toBe("closed");
    expect(result.panels.sort).toBe("closed");
  });

  it("returns parsed state when localStorage version matches VERSION = 4", () => {
    const stored = {
      version: 4,
      sidebar: false,
      panels: {
        projects: "open" as const,
        tags: "closed" as const,
        workflows: "closed" as const,
        sort: "open" as const,
      },
      selectedProjectId: "p-1",
      selectedTagId: null,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

    const result = loadState();
    expect(result.version).toBe(4);
    expect(result.sidebar).toBe(false);
    expect(result.selectedProjectId).toBe("p-1");
    expect(result.panels.projects).toBe("open");
    expect(result.panels.sort).toBe("open");
  });

  it("discards localStorage when the version field is missing", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sidebar: false,
        panels: { projects: "open", tags: "closed", workflows: "closed" },
        selectedProjectId: "stale",
        selectedTagId: null,
      })
    );

    const result = loadState();
    expect(result).toEqual(DEFAULT_STATE);
    expect(result.sidebar).toBe(true);
    expect(result.selectedProjectId).toBeNull();

    // The stale snapshot must be overwritten with DEFAULT_STATE in storage.
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const reread = raw === null ? null : JSON.parse(raw);
    expect(reread).toEqual(DEFAULT_STATE);
  });

  it("discards localStorage when the version is not 4", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 99,
        sidebar: false,
        panels: { projects: "open", tags: "closed", workflows: "closed" },
        selectedProjectId: "stale",
        selectedTagId: null,
      })
    );

    const result = loadState();
    expect(result).toEqual(DEFAULT_STATE);
    expect(result.sidebar).toBe(true);
    expect(result.selectedProjectId).toBeNull();
  });

  it("discards stored version=3 snapshot and returns DEFAULT_STATE", () => {
    // KEEP-450: v3 snapshots predate the navigation cascade flatten (Tags
    // moved to subheaders inside the Projects panel; Workflows panel
    // removed). They MUST be discarded so stale `panels.workflows` /
    // `selectedTagId` cannot leak into the new layout.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 3,
        sidebar: true,
        panels: {
          projects: "closed",
          tags: "closed",
          workflows: "open",
          sort: "closed",
        },
        selectedProjectId: null,
        selectedTagId: "stale-tag-id",
      })
    );

    const result = loadState();
    expect(result).toEqual(DEFAULT_STATE);
    expect(result.version).toBe(VERSION);
    expect(result.panels.workflows).toBe("closed");
    expect(result.selectedTagId).toBeNull();
  });

  it("writes the version field on persist", () => {
    persistState({
      ...DEFAULT_STATE,
      sidebar: false,
    });

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    if (raw === null) {
      return;
    }
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(4);
    expect(parsed.sidebar).toBe(false);
    expect(parsed.panels.sort).toBe("closed");
  });
});
