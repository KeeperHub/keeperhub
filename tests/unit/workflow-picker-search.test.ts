import { describe, expect, it } from "vitest";
import { matchesWorkflowSearch } from "@/lib/workflow/picker-search";

describe("matchesWorkflowSearch", () => {
  const name = "SkyLink: Pause Detector - USDS SkyOFTAdapter (Ethereum)";

  it("matches everything for an empty or blank query", () => {
    expect(matchesWorkflowSearch(name, "")).toBe(true);
    expect(matchesWorkflowSearch(name, "   ")).toBe(true);
  });

  it("ignores case", () => {
    expect(matchesWorkflowSearch(name, "pause")).toBe(true);
    expect(matchesWorkflowSearch(name, "ETHEREUM")).toBe(true);
  });

  it("needs every word, in any order", () => {
    expect(matchesWorkflowSearch(name, "ethereum pause")).toBe(true);
    expect(matchesWorkflowSearch(name, "pause avalanche")).toBe(false);
  });

  it("does not match unrelated text", () => {
    expect(matchesWorkflowSearch(name, "liquidation")).toBe(false);
  });
});
