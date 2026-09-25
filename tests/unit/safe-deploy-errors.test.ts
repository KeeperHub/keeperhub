import { describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";

vi.mock("server-only", () => ({}));

import { formatSafeDeployError } from "@/lib/safe/deploy-errors";

describe("formatSafeDeployError", () => {
  it("formats Panic errors with their numeric code", () => {
    // Panic(uint256) selector 0x4e487b71 followed by code 17 (0x11, overflow)
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256"],
      [17]
    );
    const panicData = `0x4e487b71${encoded.slice(2)}`;
    const report = formatSafeDeployError({ data: panicData });

    expect(report.kind).toBe("unknown");
    expect(report.message).toBe("Safe deploy failed: Panic(17)");
  });

  it("formats division by zero panic (code 18)", () => {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256"],
      [18]
    );
    const panicData = `0x4e487b71${encoded.slice(2)}`;
    const report = formatSafeDeployError({ data: panicData });

    expect(report.kind).toBe("unknown");
    expect(report.message).toBe("Safe deploy failed: Panic(18)");
  });

  it("formats create2 call failed as already-deployed", () => {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string"],
      ["Create2 call failed"]
    );
    const errorData = `0x08c379a0${encoded.slice(2)}`;
    const report = formatSafeDeployError({ data: errorData });

    expect(report.kind).toBe("already-deployed");
    expect(report.message).toContain("A Safe is already deployed");
  });
});
