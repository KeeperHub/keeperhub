// Save-time check for the next-block settings on read/write/batch-write: the
// same parser the step runs, so save and run reject the same values.

import { parseSimulationSettings } from "@/lib/web3/next-block-limits";
import { valueContainsTemplate } from "@/lib/workflow/template-ref";

export function checkSimulationConfig(
  config: Record<string, unknown>
): { field: string; message: string } | undefined {
  // A template offset is only known at run time; the step checks it then.
  const offset = valueContainsTemplate(config.simulateTimestampOffsetSec)
    ? undefined
    : config.simulateTimestampOffsetSec;
  const parsed = parseSimulationSettings(config.simulateAt, offset);
  return parsed.ok ? undefined : { field: parsed.field, message: parsed.error };
}
