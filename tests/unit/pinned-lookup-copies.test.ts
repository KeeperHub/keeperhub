import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Each trigger service builds alone, so each keeps its own copy.
const SHARED_FILES: Record<string, string[]> = {
  "pinned lookup": [
    "keeperhub-events/event-tracker/src/chains/pinned-lookup.ts",
    "keeperhub-events/solana-tracker/src/rpc-route/pinned-lookup.ts",
    "keeperhub-scheduler/lib/pinned-lookup.ts",
  ],
  "usage report queue": [
    "keeperhub-events/event-tracker/src/usage/usage-report-queue.ts",
    "keeperhub-events/solana-tracker/src/rpc-route/usage-report-queue.ts",
    "keeperhub-scheduler/lib/usage-report-queue.ts",
  ],
};

describe("trigger service shared copies", () => {
  it.each(Object.entries(SHARED_FILES))(
    "keep the %s identical across the trigger services",
    (_name, paths) => {
      const [first, ...rest] = paths.map((path) =>
        readFileSync(join(process.cwd(), path), "utf8")
      );
      for (const copy of rest) {
        expect(copy).toBe(first);
      }
    }
  );
});
