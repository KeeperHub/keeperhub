import { describe, expect, it } from "vitest";
import {
  canShareExecutionStatus,
  clearShareExecutionStatus,
} from "@/lib/workflow/share-execution-status";
import { softDeleteValues } from "@/lib/workflow/soft-delete";

describe("share execution status lifecycle helpers", () => {
  it("softDeleteValues clears shareExecutionStatus", () => {
    expect(softDeleteValues()).toEqual({
      deletedAt: expect.any(Date),
      isListed: false,
      shareExecutionStatus: false,
    });
  });

  it("clearShareExecutionStatus returns false", () => {
    expect(clearShareExecutionStatus()).toEqual({
      shareExecutionStatus: false,
    });
  });

  it("canShareExecutionStatus admits exactly the visibilities the read gate honours", () => {
    // The read gate, both write paths and the listing overlay all defer to
    // this, so it is the one place the rule can drift from itself.
    expect(canShareExecutionStatus("public")).toBe(true);
    expect(canShareExecutionStatus("unlisted")).toBe(true);
    expect(canShareExecutionStatus("private")).toBe(false);
    expect(canShareExecutionStatus(null)).toBe(false);
    expect(canShareExecutionStatus(undefined)).toBe(false);
    expect(canShareExecutionStatus("")).toBe(false);
  });
});
