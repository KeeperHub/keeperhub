// Save-time check for the next-block settings on read/write/batch-write: the
// same parser the step runs, so save and run reject the same values.

import { parseSimulationSettings } from "@/lib/web3/next-block-limits";
import { MIN_UNIX_SECONDS } from "@/lib/web3/unix-time";
import { valueContainsTemplate } from "@/lib/workflow/template-ref";

export function checkSimulationConfig(
  config: Record<string, unknown>
): { field: string; message: string } | undefined {
  // A template is only known at run time; the step checks it then.
  if (valueContainsTemplate(config.simulateAt)) {
    return;
  }
  const offset = valueContainsTemplate(config.simulateTimestampOffsetSec)
    ? undefined
    : config.simulateTimestampOffsetSec;
  const parsed = parseSimulationSettings(config.simulateAt, offset);
  return parsed.ok ? undefined : { field: parsed.field, message: parsed.error };
}

/** Read Contract's save check: Simulate at may also be "time", with a time to check at. */
export function checkReadSimulationConfig(
  config: Record<string, unknown>
): { field: string; message: string } | undefined {
  if (valueContainsTemplate(config.simulateAt)) {
    return;
  }
  const offset = valueContainsTemplate(config.simulateTimestampOffsetSec)
    ? undefined
    : config.simulateTimestampOffsetSec;
  // A templated time is read when the run starts.
  const time = valueContainsTemplate(config.simulateTime)
    ? { value: MIN_UNIX_SECONDS, strict: true }
    : { value: config.simulateTime, strict: true };
  const parsed = parseSimulationSettings(config.simulateAt, offset, time);
  return parsed.ok ? undefined : { field: parsed.field, message: parsed.error };
}
