import { describe, expect, it } from "vitest";
import { describePythMismatch } from "../../src/pyth/availability";

describe("Pyth key placement", () => {
  it("is quiet when the app and the worker agree", () => {
    expect(describePythMismatch(true, true, 3)).toBeNull();
    expect(describePythMismatch(false, false, 0)).toBeNull();
  });

  it("reports a key set only on the worker", () => {
    expect(describePythMismatch(true, false, 0)).toContain(
      "disabled on the app",
    );
  });

  it("reports a key set only on the app, with the workflows it strands", () => {
    expect(describePythMismatch(false, true, 2)).toContain(
      "2 enabled Pyth workflow(s) will not fire",
    );
  });
});
