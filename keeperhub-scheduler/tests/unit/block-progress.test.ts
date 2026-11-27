import { describe, expect, it, vi } from "vitest";
import {
  parseBlockProgress,
  parseRouteBlockProgress,
  serializeBlockProgress,
} from "../../block-dispatcher/block-progress.js";

describe("block progress annotation", () => {
  it("round-trips progress per chain", () => {
    const progress = new Map([
      [1, 21_000_000],
      [8453, 30_000_000],
    ]);

    expect(parseBlockProgress(serializeBlockProgress(progress))).toEqual(
      progress,
    );
  });

  it("returns no progress for a missing annotation", () => {
    expect(parseBlockProgress(undefined).size).toBe(0);
  });

  it("returns no progress for malformed JSON or a non-object", () => {
    vi.spyOn(console, "warn").mockImplementation((): void => {
      // suppress test output
    });

    expect(parseBlockProgress("{not json").size).toBe(0);
    expect(parseBlockProgress("[1,2]").size).toBe(0);
    expect(parseBlockProgress("42").size).toBe(0);

    vi.restoreAllMocks();
  });

  it("skips entries that are not a chain id and block number", () => {
    const raw = JSON.stringify({
      "1": 100,
      abc: 5,
      "2": "200",
      "3": -1,
      "4": 1.5,
      "0": 7,
    });

    expect(parseBlockProgress(raw)).toEqual(new Map([[1, 100]]));
  });

  it("round-trips progress per organization route key", () => {
    const progress = new Map([["route-key", 42]]);
    expect(parseRouteBlockProgress(serializeBlockProgress(progress))).toEqual(
      progress,
    );
    expect(parseRouteBlockProgress('{"":1,"k":-1}').size).toBe(0);
  });
});
