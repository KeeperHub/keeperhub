import { describe, expect, it } from "vitest";
import { ApiError, workflowSaveErrorMessage } from "@/lib/api-client";

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

  it("names the steps a save would leave without an RPC endpoint", () => {
    const error = new ApiError(
      409,
      "Some steps would have no RPC endpoint to use. Pick an RPC config for each one listed.",
      undefined,
      {
        code: "COVERAGE_GAPS",
        gaps: [
          { nodeLabel: "Read balance", message: "No config covers Base." },
        ],
      }
    );
    expect(workflowSaveErrorMessage(error, "Failed to save")).toContain(
      '"Read balance": No config covers Base.'
    );
  });
});
