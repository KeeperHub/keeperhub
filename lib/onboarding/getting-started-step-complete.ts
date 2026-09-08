import type { Step } from "@/lib/onboarding/getting-started-config";

export type StepCompleteStatus = {
  hasApiKey: boolean;
  hasIntegration: boolean;
  executedWorkflowIds: string[];
};

export type StepCompleteInput = {
  step: Step;
  done: string[];
  workflows: Record<string, string>;
  status: StepCompleteStatus | null;
  isWorkflowLive: (id: string | undefined) => boolean;
  resolveRealSignal: (
    step: Step,
    status: StepCompleteStatus | null,
    workflows: Record<string, string>
  ) => boolean;
  isClickDriven: (signal: Step["signal"]) => boolean;
};

/**
 * Hybrid completion for getting-started steps.
 *
 * Chip-bearing steps:
 *  - If any chip was ever cloned (`workflows[step:chip]` recorded), derive
 *    completion from a LIVE clone (or a real ran/alert signal). Deleting the
 *    clone cleanly un-completes the step.
 *  - If no chip was ever cloned, honor `done` so users who finished the step
 *    before chips existed do not regress when chips are added.
 *
 * Non-chip steps keep the existing latch-then-signal behaviour.
 */
export function isChipAwareStepComplete(input: StepCompleteInput): boolean {
  const {
    step,
    done,
    workflows,
    status,
    isWorkflowLive,
    resolveRealSignal,
    isClickDriven,
  } = input;

  if (step.signal === "always") {
    return true;
  }

  if (step.chips && step.chips.length > 0) {
    const chipKey = (chipId: string): string => `${step.key}:${chipId}`;
    const hasLiveClone = step.chips.some((chip) =>
      isWorkflowLive(workflows[chipKey(chip.id)])
    );
    const everCloned = step.chips.some(
      (chip) => workflows[chipKey(chip.id)] !== undefined
    );
    if (everCloned) {
      return hasLiveClone || resolveRealSignal(step, status, workflows);
    }
    return (
      done.includes(step.key) || resolveRealSignal(step, status, workflows)
    );
  }

  if (done.includes(step.key)) {
    return true;
  }
  if (isClickDriven(step.signal)) {
    return false;
  }
  return resolveRealSignal(step, status, workflows);
}
