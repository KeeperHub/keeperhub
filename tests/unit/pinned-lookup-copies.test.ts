import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Each trigger service builds alone, so each keeps its own copy.
const COPIES = [
  "keeperhub-events/event-tracker/src/chains/pinned-lookup.ts",
  "keeperhub-events/solana-tracker/src/rpc-route/pinned-lookup.ts",
  "keeperhub-scheduler/lib/pinned-lookup.ts",
];

describe("pinned lookup copies", () => {
  it("stay identical across the trigger services", () => {
    const [first, ...rest] = COPIES.map((path) =>
      readFileSync(join(process.cwd(), path), "utf8")
    );
    for (const copy of rest) {
      expect(copy).toBe(first);
    }
  });
});
