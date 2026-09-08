// @vitest-environment jsdom

import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({
  api: {
    workflow: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    WORKFLOW_ENGINE: "workflow_engine",
    UNKNOWN: "unknown",
  },
  logSystemError: vi.fn(),
  logUserError: vi.fn(),
}));

vi.mock("@/lib/workflow/editor/auto-layout", () => ({
  computeAutoLayout: vi.fn((nodes: unknown) => nodes),
}));

vi.mock("@/lib/workflow/editor/template-helpers", () => ({
  buildExecutionLogsMap: vi.fn(() => ({})),
}));

import { api } from "@/lib/api-client";
import {
  autosaveAtom,
  cancelPendingAutosave,
  currentWorkflowIdAtom,
  hasUnsavedChangesAtom,
} from "@/lib/workflow/store";

const updateMock = vi.mocked(api.workflow.update);

// The saveFunc inside autosaveAtom holds isSaving for 800ms after the API
// call resolves; advance past it so awaiting the save promise settles.
const SAVE_COOLDOWN_MS = 800;

describe("workflow store autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateMock.mockClear();
  });

  afterEach(() => {
    cancelPendingAutosave();
    vi.useRealTimers();
  });

  function storeWithWorkflow() {
    const store = createStore();
    store.set(currentWorkflowIdAtom, "wf-1");
    return store;
  }

  it("fires a debounced save after the delay", async () => {
    const store = storeWithWorkflow();

    await store.set(autosaveAtom);
    expect(updateMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2500 + SAVE_COOLDOWN_MS);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("cancelPendingAutosave drops a scheduled save", async () => {
    const store = storeWithWorkflow();

    await store.set(autosaveAtom);
    cancelPendingAutosave();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("an immediate save clears the pending debounced save", async () => {
    const store = storeWithWorkflow();

    await store.set(autosaveAtom);

    const immediate = store.set(autosaveAtom, { immediate: true });
    await vi.advanceTimersByTimeAsync(SAVE_COOLDOWN_MS);
    await immediate;
    expect(updateMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("clears the unsaved-changes flag on a successful save", async () => {
    const store = storeWithWorkflow();
    store.set(hasUnsavedChangesAtom, true);

    const immediate = store.set(autosaveAtom, { immediate: true });
    await vi.advanceTimersByTimeAsync(SAVE_COOLDOWN_MS);
    await immediate;

    expect(store.get(hasUnsavedChangesAtom)).toBe(false);
  });
});
