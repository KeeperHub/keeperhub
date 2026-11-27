import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  DUPLICATE_ERROR_TOAST,
  duplicateErrorMessage,
  WORKFLOW_SAVE_ERROR_TOAST,
  workflowSaveErrorMessage,
} from "@/lib/api-client";

/** Every .ts/.tsx file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const SUMMARY =
  "Workflow contains invalid action configuration. Invalid node(s): \"Filter\": Value for 'Number: greater than' must be a number, e.g. 100 or 0x64. Fix the listed fields and save again.";

describe("workflowSaveErrorMessage", () => {
  it("shows the server's reason for a refused action config", () => {
    const error = new ApiError(422, "INVALID_ACTION_CONFIG", SUMMARY);
    expect(workflowSaveErrorMessage(error, "Failed to save")).toBe(SUMMARY);
  });

  it("keeps the fallback for any other failure", () => {
    expect(
      workflowSaveErrorMessage(
        new ApiError(500, "Internal error", "boom"),
        "Failed to save"
      )
    ).toBe("Failed to save");
    expect(
      workflowSaveErrorMessage(
        new ApiError(422, "INVALID_ACTION_CONFIG"),
        "Failed to save"
      )
    ).toBe("Failed to save");
    expect(workflowSaveErrorMessage(new Error("x"), "Failed to save")).toBe(
      "Failed to save"
    );
  });
});

describe("duplicateErrorMessage", () => {
  it("shows why a copy was refused, and keeps any other error's own text", () => {
    const refused =
      'This workflow cannot be copied into your organization. Invalid node(s): "Keeper call": Send as: Bundle is not turned on for this organization yet. Nothing was copied.';
    expect(
      duplicateErrorMessage(
        new ApiError(422, "INVALID_ACTION_CONFIG", refused),
        "Failed"
      )
    ).toBe(refused);
    expect(
      duplicateErrorMessage(new ApiError(404, "Not found"), "Failed")
    ).toBe("Not found");
    expect(duplicateErrorMessage("boom", "Failed")).toBe("Failed");
  });
});

describe("copy failure toasts", () => {
  it("every duplicate caller holds its toast as long as a save failure's", () => {
    expect(DUPLICATE_ERROR_TOAST.duration).toBe(
      WORKFLOW_SAVE_ERROR_TOAST.duration
    );
    const callers = ["app", "components", "hooks", "lib"]
      .flatMap((dir) => sourceFiles(join(process.cwd(), dir)))
      .filter((file) =>
        readFileSync(file, "utf8").includes("api.workflow.duplicate(")
      );
    expect(callers.length).toBeGreaterThanOrEqual(7);
    for (const file of callers) {
      expect(readFileSync(file, "utf8"), file).toContain(
        "DUPLICATE_ERROR_TOAST"
      );
    }
  });
});
