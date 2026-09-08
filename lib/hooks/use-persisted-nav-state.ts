"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type PanelState = "open" | "collapsed" | "closed";

type NavPanelStates = {
  projects: PanelState;
  tags: PanelState;
  workflows: PanelState;
  // Phase 43 / HUB-23: Hub sidebar Sort section. Independent of the
  // projects -> tags -> workflows cascade — peelRightmost / applyPanelClose
  // do not touch this slot. The HubSidebar component owns its own
  // first-paint expanded default via local state when this is "closed".
  sort: PanelState;
};

type PersistedNavState = {
  version: number;
  sidebar: boolean;
  panels: NavPanelStates;
  selectedProjectId: string | null;
  selectedTagId: string | null;
};

const STORAGE_KEY = "keeperhub-nav-state";
const LEGACY_KEY = "keeperhub-sidebar-expanded";
const VERSION = 4;

const DEFAULT_STATE: PersistedNavState = {
  version: VERSION,
  sidebar: true,
  panels: {
    projects: "closed",
    tags: "closed",
    workflows: "closed",
    sort: "closed",
  },
  selectedProjectId: null,
  selectedTagId: null,
};

function loadState(): PersistedNavState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedNavState>;
      if (parsed.version !== VERSION) {
        // NAV-07: stale snapshot - discard. NAV-FUTURE-01 will revisit migration.
        localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_STATE));
        return DEFAULT_STATE;
      }
      return parsed as PersistedNavState;
    }

    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy !== null) {
      const migrated: PersistedNavState = {
        ...DEFAULT_STATE,
        sidebar: legacy === "true",
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      localStorage.removeItem(LEGACY_KEY);
      return migrated;
    }
  } catch {
    // Ignore storage errors
  }
  return DEFAULT_STATE;
}

function applyPanelClose(
  panel: keyof NavPanelStates,
  current: PersistedNavState
): PersistedNavState {
  const panels = { ...current.panels };
  let { selectedProjectId, selectedTagId } = current;

  if (panel === "projects") {
    panels.projects = "closed";
    panels.tags = "closed";
    panels.workflows = "closed";
    selectedProjectId = null;
    selectedTagId = null;
  } else if (panel === "tags") {
    panels.tags = "closed";
    panels.workflows = "closed";
    selectedTagId = null;
  } else {
    panels.workflows = "closed";
  }

  return { ...current, panels, selectedProjectId, selectedTagId };
}

function applyPanelCollapse(
  panel: keyof NavPanelStates,
  current: PersistedNavState
): PersistedNavState {
  const panels = { ...current.panels };
  panels[panel] = "collapsed";
  return { ...current, panels };
}

// Cookie used by the root layout to set --nav-sidebar-width on <html>
// during SSR so page wrappers paint at the correct left margin without
// a JS hop. Lifetime ~1 year; non-secure so it's available everywhere
// the user navigates.
const SIDEBAR_WIDTH_COOKIE = "kh_nav_sidebar_w";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function persistSidebarWidthCookie(expanded: boolean): void {
  try {
    const width = expanded ? 200 : 60;
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API isn't shipped in all evergreen browsers yet (Safari lags); document.cookie is the broadly supported write path.
    document.cookie = `${SIDEBAR_WIDTH_COOKIE}=${width}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
  } catch {
    // Ignore (some embedded contexts disallow cookies)
  }
}

function persistState(state: PersistedNavState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
  persistSidebarWidthCookie(state.sidebar);
}

type UsePersistedNavStateReturn = {
  state: PersistedNavState;
  hasMounted: boolean;
  setSidebar: (expanded: boolean) => void;
  setPanelState: (panel: keyof NavPanelStates, next: PanelState) => void;
  setSelectedProject: (id: string | null) => void;
  setSelectedTag: (id: string | null) => void;
  closeAll: () => void;
  foldAll: () => void;
  peelRightmost: () => void;
  validateSelections: (projectIds: string[], tagIds: string[]) => void;
};

export function usePersistedNavState(): UsePersistedNavStateReturn {
  const [state, setState] = useState<PersistedNavState>(DEFAULT_STATE);
  const stateRef = useRef(state);
  const [hasMounted, setHasMounted] = useState(false);

  // Keep ref in sync with state
  stateRef.current = state;

  useEffect(() => {
    const loaded = loadState();
    stateRef.current = loaded;
    setState(loaded);
    setHasMounted(true);
    // Seed the SSR cookie on first mount so existing users get the
    // server-side render path on their next page load. New writes go
    // through commit() -> persistState() which already updates the
    // cookie.
    persistSidebarWidthCookie(loaded.sidebar);
  }, []);

  const commit = useCallback((next: PersistedNavState) => {
    stateRef.current = next;
    setState(next);
    persistState(next);
  }, []);

  const setSidebar = useCallback(
    (expanded: boolean) => {
      commit({ ...stateRef.current, sidebar: expanded });
    },
    [commit]
  );

  const setPanelState = useCallback(
    (panel: keyof NavPanelStates, next: PanelState) => {
      const current = stateRef.current;

      if (next === "closed") {
        commit(applyPanelClose(panel, current));
        return;
      }

      if (next === "collapsed") {
        commit(applyPanelCollapse(panel, current));
        return;
      }

      const panels = { ...current.panels };
      panels[panel] = "open";
      commit({ ...current, panels });
    },
    [commit]
  );

  const setSelectedProject = useCallback(
    (id: string | null) => {
      commit({ ...stateRef.current, selectedProjectId: id });
    },
    [commit]
  );

  const setSelectedTag = useCallback(
    (id: string | null) => {
      commit({ ...stateRef.current, selectedTagId: id });
    },
    [commit]
  );

  const closeAll = useCallback(() => {
    // Preserve the existing sort panel state — closeAll targets the
    // navigation cascade (projects -> tags -> workflows), not the
    // independent Hub sidebar Sort section (HUB-23).
    commit({
      ...stateRef.current,
      panels: {
        ...stateRef.current.panels,
        projects: "closed",
        tags: "closed",
        workflows: "closed",
      },
      selectedProjectId: null,
      selectedTagId: null,
    });
  }, [commit]);

  const foldAll = useCallback(() => {
    const current = stateRef.current;
    const panels = { ...current.panels };
    for (const key of Object.keys(panels) as (keyof NavPanelStates)[]) {
      if (panels[key] === "open") {
        panels[key] = "collapsed";
      }
    }
    commit({ ...current, panels });
  }, [commit]);

  const peelRightmost = useCallback(() => {
    const current = stateRef.current;
    const panels = { ...current.panels };
    let { selectedProjectId, selectedTagId } = current;

    if (panels.workflows !== "closed") {
      panels.workflows = "closed";
      if (panels.tags === "collapsed") {
        panels.tags = "open";
      }
    } else if (panels.tags !== "closed") {
      panels.tags = "closed";
      selectedTagId = null;
      if (panels.projects === "collapsed") {
        panels.projects = "open";
      }
    } else if (panels.projects !== "closed") {
      panels.projects = "closed";
      selectedProjectId = null;
    }

    commit({ ...current, panels, selectedProjectId, selectedTagId });
  }, [commit]);

  const validateSelections = useCallback(
    (projectIds: string[], tagIds: string[]) => {
      const current = stateRef.current;
      const panels = { ...current.panels };
      let { selectedProjectId, selectedTagId } = current;
      let changed = false;

      if (selectedProjectId && !projectIds.includes(selectedProjectId)) {
        selectedProjectId = null;
        panels.tags = "closed";
        panels.workflows = "closed";
        selectedTagId = null;
        changed = true;
      }

      if (
        selectedTagId &&
        selectedTagId !== "__untagged__" &&
        !tagIds.includes(selectedTagId)
      ) {
        selectedTagId = null;
        panels.workflows = "closed";
        changed = true;
      }

      if (changed) {
        commit({ ...current, panels, selectedProjectId, selectedTagId });
      }
    },
    [commit]
  );

  return {
    state,
    hasMounted,
    setSidebar,
    setPanelState,
    setSelectedProject,
    setSelectedTag,
    closeAll,
    foldAll,
    peelRightmost,
    validateSelections,
  };
}

export type { NavPanelStates, PanelState, PersistedNavState };

// Test-only exports. The hook itself is the public surface; these helpers are
// exposed so unit tests can exercise the version-discard branch without a
// React renderer (this codebase does not depend on @testing-library/react).
export {
  DEFAULT_STATE as __DEFAULT_STATE_FOR_TESTING,
  LEGACY_KEY as __LEGACY_KEY_FOR_TESTING,
  loadState as __loadStateForTesting,
  persistState as __persistStateForTesting,
  STORAGE_KEY as __STORAGE_KEY_FOR_TESTING,
  VERSION as __VERSION_FOR_TESTING,
};
