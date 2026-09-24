import { describe, expect, it } from "vitest";
import {
  formatStoredBytes,
  isTruncatedOutput,
  MAX_STORED_OUTPUT_BYTES,
} from "@/lib/workflow/output-limits";

describe("output limits", () => {
  it("is one MiB", () => {
    expect(MAX_STORED_OUTPUT_BYTES).toBe(1024 * 1024);
  });

  it("recognises the truncated marker and nothing else", () => {
    expect(
      isTruncatedOutput({ _truncated: true, originalSize: 5, preview: "{" })
    ).toBe(true);
    expect(isTruncatedOutput({ _truncated: false, originalSize: 5 })).toBe(
      false
    );
    expect(isTruncatedOutput({ _truncated: true })).toBe(false);
    expect(isTruncatedOutput({ truncated: true, bytes: 5 })).toBe(false);
    expect(isTruncatedOutput(null)).toBe(false);
    expect(isTruncatedOutput("_truncated")).toBe(false);
    expect(isTruncatedOutput([])).toBe(false);
  });

  it("formats sizes for the notice", () => {
    expect(formatStoredBytes(184_421_952)).toBe("175.9 MiB");
    expect(formatStoredBytes(1_048_576)).toBe("1.0 MiB");
    expect(formatStoredBytes(543_237)).toBe("531 KiB");
    expect(formatStoredBytes(92)).toBe("92 bytes");
  });
});
