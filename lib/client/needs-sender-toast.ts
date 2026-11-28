"use client";

import { toast } from "sonner";
import {
  type StepNeedingSender,
  stepsNeedingSenderNotice,
} from "@/lib/workflow/copy-safe-connections";

/** After a copy or import, names the steps that need a sender; stays until closed. */
export function toastStepsNeedingSender(copy: {
  stepsNeedingSender?: readonly StepNeedingSender[];
}): void {
  // A response from a server without the list names nothing.
  const notice = stepsNeedingSenderNotice(copy.stepsNeedingSender ?? []);
  if (notice !== null) {
    toast.warning(notice, {
      closeButton: true,
      duration: Number.POSITIVE_INFINITY,
    });
  }
}
