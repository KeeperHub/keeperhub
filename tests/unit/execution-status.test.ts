import { describe, expect, it } from "vitest";
import {
  ERROR_STATUSES,
  statusForErrorType,
} from "@/lib/errors/execution-status";

describe("statusForErrorType", () => {
  it("maps system failures to system_error", () => {
    expect(statusForErrorType("system")).toBe("system_error");
  });

  it("maps user failures to error", () => {
    expect(statusForErrorType("user")).toBe("error");
  });

  it("maps external dependency failures to error (KeeperHub is healthy)", () => {
    expect(statusForErrorType("external")).toBe("error");
  });

  it("defaults null/undefined to error", () => {
    expect(statusForErrorType(null)).toBe("error");
    expect(statusForErrorType(undefined)).toBe("error");
  });
});

describe("ERROR_STATUSES", () => {
  it("contains both failure statuses", () => {
    expect(ERROR_STATUSES).toEqual(["error", "system_error"]);
  });
});
