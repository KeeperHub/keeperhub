/**
 * Duration buckets offered by the runs filter. Bounds are milliseconds, min
 * inclusive and max exclusive, so consecutive presets never both match a run.
 */
export type DurationPresetId = "under5s" | "5sTo30s" | "over30s" | "over2m";

export type DurationPreset = {
  id: DurationPresetId;
  label: string;
  minMs?: number;
  maxMs?: number;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const DURATION_PRESETS: DurationPreset[] = [
  { id: "under5s", label: "Under 5s", maxMs: 5 * SECOND },
  { id: "5sTo30s", label: "5s to 30s", minMs: 5 * SECOND, maxMs: 30 * SECOND },
  { id: "over30s", label: "Over 30s", minMs: 30 * SECOND },
  { id: "over2m", label: "Over 2m", minMs: 2 * MINUTE },
];

export function durationPreset(
  id: DurationPresetId | null
): DurationPreset | undefined {
  return DURATION_PRESETS.find((preset) => preset.id === id);
}
