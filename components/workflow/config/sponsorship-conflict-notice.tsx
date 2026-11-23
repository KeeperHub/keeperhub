"use client";

import { AlertTriangle } from "lucide-react";
import {
  SPONSORSHIP_GAS_SETTINGS_DOC_URL,
  sponsorshipConflictFor,
} from "@/lib/workflow/editor/sponsorship-conflict";
import type {
  ActionConfigFieldBase,
  SponsorshipConflict,
} from "@/plugins/registry";

const MESSAGES: Record<SponsorshipConflict, string> = {
  "skips-sponsorship":
    "Gas sponsorship is skipped while this is set, because sponsored sends cannot carry a custom fee. This node pays gas from the sending wallet, which must hold enough native token.",
  "not-applied-when-sponsored":
    "Not applied while Sponsor gas is on: sponsored sends set their own gas limit. This limit is used only when the node pays its own gas. Turn off Sponsor gas to always use it.",
};

type SponsorshipConflictNoticeProps = {
  field: ActionConfigFieldBase;
  config: Record<string, unknown>;
};

export function SponsorshipConflictNotice({
  field,
  config,
}: SponsorshipConflictNoticeProps) {
  const conflict = sponsorshipConflictFor(field, config);
  if (!conflict) {
    return null;
  }
  return (
    <div
      className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-700 text-xs dark:text-amber-300"
      data-testid={`sponsorship-conflict-${field.key}`}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span className="break-words">
        {MESSAGES[conflict]}{" "}
        <a
          className="break-all underline"
          href={SPONSORSHIP_GAS_SETTINGS_DOC_URL}
          rel="noopener noreferrer"
          target="_blank"
        >
          {SPONSORSHIP_GAS_SETTINGS_DOC_URL}
        </a>
      </span>
    </div>
  );
}
