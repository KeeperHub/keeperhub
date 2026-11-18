import { describe, expect, it } from "vitest";
import { flushExtraSaves, registerExtraSave } from "@/lib/workflow/extra-saves";

describe("extra saves", () => {
  it("reports unsaved while any flush is unsaved, and forgets a removed one", async () => {
    const saved = registerExtraSave(() => Promise.resolve(true));
    const unsaved = registerExtraSave(() => Promise.resolve(false));
    expect(await flushExtraSaves()).toBe(false);
    unsaved();
    expect(await flushExtraSaves()).toBe(true);
    saved();
    expect(await flushExtraSaves()).toBe(true);
  });
});
