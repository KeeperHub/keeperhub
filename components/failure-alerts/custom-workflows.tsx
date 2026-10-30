"use client";

import Link from "next/link";
import type { OrgSettingsView } from "@/lib/notifications/failure-alerts/view-types";
import { failedRuns, formatWhen } from "./format";

type CustomWorkflow = OrgSettingsView["customWorkflows"][number];

/** What this workflow does differently, in a few words. */
function differences(w: CustomWorkflow): string {
  const parts: string[] = [];
  if (w.muteUntilSuccess) {
    parts.push("muted until it works again");
  } else if (w.mutedUntil) {
    parts.push(`muted until ${formatWhen(w.mutedUntil)}`);
  }
  if (w.threshold) {
    parts.push(`alerts after ${failedRuns(w.threshold)}`);
  }
  if (w.customRecipients) {
    parts.push("emails its own people");
  }
  if (w.customChannels) {
    parts.push("uses its own methods");
  }
  if (w.pauseWorkflow) {
    parts.push("turns itself off at its limit");
  }
  const text = parts.join(", ") || "own settings";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Workflows that do not follow the org rules, so mutes are never forgotten. */
export function CustomWorkflowsList({
  workflows,
}: {
  workflows: CustomWorkflow[];
}): React.ReactElement {
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
          <span className="text-muted-foreground text-xs">
            {differences(w)}
          </span>
        </li>
      ))}
    </ul>
  );
}
