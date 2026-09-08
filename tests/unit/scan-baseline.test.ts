/**
 * Unit tests for buildBaselineSuggestions — the empty-state fallback that
 * offers gas-balance monitors valid for any address (no holdings required).
 */
import { describe, expect, it } from "vitest";
import { buildWorkflow } from "@/lib/scan/factory";
import { buildBaselineSuggestions } from "@/lib/scan/suggestions/baseline";

const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const GAS_BALANCE_ID_RE = /^gas-balance-\d+$/;
const DIGITS_RE = /^\d+$/;

describe("buildBaselineSuggestions", () => {
  it("returns gas-balance monitors carrying the address prefill", () => {
    const suggestions = buildBaselineSuggestions(ADDRESS);

    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(suggestion.id).toMatch(GAS_BALANCE_ID_RE);
      expect(suggestion.category).toBe("alert");
      expect(suggestion.readOrWrite).toBe("read");
      // The factory gas-balance shape reads these two keys.
      expect(suggestion.confirmInputs.walletAddress).toBe(ADDRESS);
      expect(suggestion.confirmInputs.gasThreshold).toMatch(DIGITS_RE);
    }
  });

  it("emits one monitor per baseline chain with distinct ids", () => {
    const ids = buildBaselineSuggestions(ADDRESS).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("produces descriptors the factory can build into a real workflow", () => {
    // The empty-state cards open the same preview drawer, which calls
    // buildWorkflow. If these descriptors did not build, the preview canvas
    // would render blank — assert they yield a non-empty node/edge graph.
    for (const suggestion of buildBaselineSuggestions(ADDRESS)) {
      const workflow = buildWorkflow(suggestion);
      expect(workflow.nodes.length).toBeGreaterThan(0);
      expect(workflow.edges.length).toBeGreaterThan(0);
    }
  });
});
