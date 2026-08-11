import { describe, expect, it, vi } from "vitest";

import { ensureSavedBeforeRun } from "@/lib/workflow/run-preflight";

describe("ensureSavedBeforeRun", () => {
  it("allows the run without saving when there are no unsaved changes", async () => {
    const save = vi.fn().mockResolvedValue(true);

    const result = await ensureSavedBeforeRun({
      hasUnsavedChanges: false,
      isPreviewingVersion: false,
      save,
    });

    expect(result).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("never saves while previewing a historical version", async () => {
    const save = vi.fn().mockResolvedValue(true);

    const result = await ensureSavedBeforeRun({
      hasUnsavedChanges: true,
      isPreviewingVersion: true,
      save,
    });

    expect(result).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("saves before allowing the run when there are unsaved changes", async () => {
    const save = vi.fn().mockResolvedValue(true);

    const result = await ensureSavedBeforeRun({
      hasUnsavedChanges: true,
      isPreviewingVersion: false,
      save,
    });

    expect(result).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("aborts the run when the save fails", async () => {
    const save = vi.fn().mockResolvedValue(false);

    const result = await ensureSavedBeforeRun({
      hasUnsavedChanges: true,
      isPreviewingVersion: false,
      save,
    });

    expect(result).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
