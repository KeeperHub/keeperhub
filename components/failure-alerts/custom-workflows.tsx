"use client";

import Link from "next/link";
import type { OrgSettingsView } from "@/lib/notifications/failure-alerts/view-types";
import { TextWithEmails } from "./email-text";
import { failedRuns, timeLimitLabel } from "./format";
import { muteSentence } from "./member-label";

type CustomWorkflow = OrgSettingsView["customWorkflows"][number];
type MutedWorkflow = OrgSettingsView["mutedWorkflows"][number];

/** The Setup line's mute, worded as on Overview and in the workflow panel. */
function muteText(w: CustomWorkflow, mute: MutedWorkflow | undefined): string {
  return muteSentence({
    by: mute?.by ?? null,
    account: mute?.byAccount ?? null,
    untilItWorks: w.muteUntilSuccess,
    mutedUntil: w.mutedUntil,
    reason: mute?.reason ?? null,
  });
}

/** What this workflow does differently: its mute as one sentence, its own rules as another. */
function differences(
  w: CustomWorkflow,
  mute: MutedWorkflow | undefined
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
  if (w.pauseWorkflow) {
    parts.push("disables itself at its limit");
  }
  const sentences: string[] = [];
  if (w.muteUntilSuccess || w.mutedUntil) {
    const muted = muteText(w, mute);
    sentences.push(muted.endsWith(".") ? muted : `${muted}.`);
  }
  if (parts.length > 0) {
    sentences.push(`Own rules: ${parts.join(", ")}.`);
  }
  return sentences.join(" ") || "Own settings.";
}

/** Workflows that do not follow the org rules, so mutes are never forgotten. */
export function CustomWorkflowsList({
  workflows,
  muted = [],
}: {
  workflows: CustomWorkflow[];
  /** Who muted each one and why. */
  muted?: MutedWorkflow[];
}): React.ReactElement {
  const muteById = new Map(muted.map((m) => [m.id, m]));
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
              <TextWithEmails text={differences(w, muteById.get(w.id))} />
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
