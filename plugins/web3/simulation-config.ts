// Save-time check for the next-block settings on read/write/batch-write. Free
// of ethers so the plugin definitions can run it; the step re-checks it.

import {
  MAX_SIMULATE_TIMESTAMP_OFFSET_SEC,
  MIN_SIMULATE_TIMESTAMP_OFFSET_SEC,
} from "@/lib/web3/next-block-limits";
import { valueContainsTemplate } from "@/lib/workflow/template-ref";

const WHOLE_SECONDS = /^\d+$/;

export function checkSimulationConfig(
  config: Record<string, unknown>
): { field: string; message: string } | undefined {
  const mode =
    typeof config.simulateAt === "string"
      ? config.simulateAt.trim().toLowerCase()
      : config.simulateAt;
  const offset = config.simulateTimestampOffsetSec;
  // The offset is hidden and unused with Latest block.
  if (
    mode !== "next-block" ||
    offset === undefined ||
    offset === null ||
    offset === "" ||
    valueContainsTemplate(offset)
  ) {
    return;
  }
  const text = String(offset).trim();
  const seconds = Number(text);
  if (
    WHOLE_SECONDS.test(text) &&
    seconds >= MIN_SIMULATE_TIMESTAMP_OFFSET_SEC &&
    seconds <= MAX_SIMULATE_TIMESTAMP_OFFSET_SEC
  ) {
    return;
  }
  return {
    field: "simulateTimestampOffsetSec",
    message: `Next block timestamp offset must be a whole number of seconds from ${MIN_SIMULATE_TIMESTAMP_OFFSET_SEC} to ${MAX_SIMULATE_TIMESTAMP_OFFSET_SEC}`,
  };
}
