import { describe, expect, it } from "vitest";
import { ApiError, workflowSaveErrorMessage } from "@/lib/api-client";

describe("workflowSaveErrorMessage", () => {
  it("shows the server's reason for a refused action config", () => {
    const error = new ApiError(
      422,
      "INVALID_ACTION_CONFIG",
      'Workflow contains invalid action configuration. Invalid node(s): "Filter" (value).'
    );
    expect(workflowSaveErrorMessage(error, "Failed to save")).toBe(
      'Workflow contains invalid action configuration. Invalid node(s): "Filter" (value).'
    );
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
