import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  extractLogGasUsedWei,
  extractLogNetwork,
} from "@/lib/db/execution-log-fields";

describe("extractLogNetwork", () => {
  it("returns the network string from a plain object", () => {
    expect(extractLogNetwork({ network: "ethereum" })).toBe("ethereum");
  });

  it("coerces a non-string scalar to its text form, matching ->>", () => {
    expect(extractLogNetwork({ network: 1 })).toBe("1");
  });

  it("returns null when the key is absent", () => {
    expect(extractLogNetwork({ chainId: 1 })).toBeNull();
  });

  it("returns null for null / array / primitive sources", () => {
    expect(extractLogNetwork(null)).toBeNull();
    expect(extractLogNetwork(["network"])).toBeNull();
    expect(extractLogNetwork("ethereum")).toBeNull();
  });

  it("returns null when the value is itself an object", () => {
    expect(extractLogNetwork({ network: { name: "ethereum" } })).toBeNull();
  });
});

describe("extractLogGasUsedWei", () => {
  it("returns the numeric text from a string gasUsed", () => {
    expect(extractLogGasUsedWei({ gasUsed: "21000" })).toBe("21000");
  });

  it("returns the numeric text from a number gasUsed", () => {
    expect(extractLogGasUsedWei({ gasUsed: 21_000 })).toBe("21000");
  });

  it("returns null when gasUsed is absent", () => {
    expect(extractLogGasUsedWei({ network: "ethereum" })).toBeNull();
  });

  it("returns null for an empty or non-numeric gasUsed", () => {
    expect(extractLogGasUsedWei({ gasUsed: "" })).toBeNull();
    expect(extractLogGasUsedWei({ gasUsed: "  " })).toBeNull();
    expect(extractLogGasUsedWei({ gasUsed: "not-a-number" })).toBeNull();
  });

  it("returns null for null / array / primitive sources", () => {
    expect(extractLogGasUsedWei(null)).toBeNull();
    expect(extractLogGasUsedWei([21_000])).toBeNull();
    expect(extractLogGasUsedWei(21_000)).toBeNull();
  });
});
