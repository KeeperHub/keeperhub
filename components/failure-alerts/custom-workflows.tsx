"use client";

import Link from "next/link";
import type { OrgSettingsView } from "@/lib/notifications/failure-alerts/view-types";
import { TextWithEmails } from "./email-text";
import { failedRuns, timeLimitLabel } from "./format";
import { pauseSentence } from "./member-label";

type CustomWorkflow = OrgSettingsView["customWorkflows"][number];
type PausedWorkflow = OrgSettingsView["alertsPausedWorkflows"][number];

/** The Setup line's pause, worded as on Overview and in the workflow panel. */
function pauseText(
  w: CustomWorkflow,
  pause: PausedWorkflow | undefined
): string {
  return pauseSentence({
    by: pause?.by ?? null,
    account: pause?.byAccount ?? null,
    untilItWorks: w.pauseUntilSuccess,
    pausedUntil: w.pausedUntil,
    reason: pause?.reason ?? null,
  });
}

/** What this workflow does differently: its pause as one sentence, its own rules as another. */
function differences(
  w: CustomWorkflow,
  pause: PausedWorkflow | undefined
): string {
  const parts: string[] = [];
  if (w.threshold) {
    parts.push(`alerts after ${failedRuns(w.threshold)}`);
  }
  if (w.timeLimitMinutes === 0) {
    parts.push("no time limit");
  } else if (w.timeLimitMinutes) {
    parts.push(`time limit ${timeLimitLabel(w.timeLimitMinutes)}`);
  }
  if (w.customRecipients) {
    parts.push("emails its own people");
  }
  if (w.customChannels) {
    parts.push("uses its own methods");
  }
  if (w.disableWorkflow) {
    parts.push("disables itself at its limit");
  }
  const sentences: string[] = [];
  if (w.pauseUntilSuccess || w.pausedUntil) {
    const paused = pauseText(w, pause);
    sentences.push(paused.endsWith(".") ? paused : `${paused}.`);
  }
  if (parts.length > 0) {
    sentences.push(`Own rules: ${parts.join(", ")}.`);
  }
  return sentences.join(" ") || "Own settings.";
}

/** Workflows that do not follow the org rules, so pauses are never forgotten. */
export function CustomWorkflowsList({
  workflows,
  paused = [],
}: {
  workflows: CustomWorkflow[];
  /** Who paused each one and why. */
  paused?: PausedWorkflow[];
}): React.ReactElement {
  const pauseById = new Map(paused.map((m) => [m.id, m]));
  return (
    <ul
      className="divide-y rounded-md border"
      data-testid="failure-alerts-custom-workflows"
    >
      {workflows.map((w) => (
        <li
          className="flex flex-col gap-0.5 px-3 py-2 text-sm @xl/settings:flex-row @xl/settings:items-baseline @xl/settings:justify-between @xl/settings:gap-3"
          key={w.id}
        >
          <Link
            className="min-w-0 break-words font-medium underline underline-offset-4"
            href={`/workflows/${w.id}`}
          >
            {w.name}
          </Link>
          <span className="flex flex-col gap-0.5 text-xs @xl/settings:items-end">
            <span className="text-muted-foreground">
              <TextWithEmails text={differences(w, pauseById.get(w.id))} />
            </span>
            {w.brokenMethods > 0 && (
              <span
                className="font-medium text-destructive"
                data-testid="failure-alerts-custom-broken"
              >
                {w.brokenMethods === 1
                  ? "1 of its methods stopped working"
                  : `${w.brokenMethods} of its methods stopped working`}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
