"use client";

import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { useSendModeChains } from "@/lib/hooks/use-send-mode-chains";
import { cn } from "@/lib/utils";
import { sendModeOption } from "@/lib/web3/send-mode";
import {
  editorSendMode,
  sendModeWarning,
  sendsPrivately,
} from "@/lib/workflow/editor/send-mode-editor";

// text-[0.6875rem] is --ds-text-xs (11px); no Tailwind class maps to it (scripts/token-audit.js).
const SEND_MODE_BADGE_CLASS =
  "rounded border px-1.5 py-0.5 font-semibold text-[0.6875rem] uppercase leading-none tracking-wide";

// How a write node sends (e.g. PRIVATE), or a warning when Send as stops it.
export function SendModeBadge({
  config,
}: {
  config: Record<string, unknown>;
}): ReactNode {
  // Re-renders once the chain list is known (an old flag depends on it).
  useSendModeChains();
  const warning = sendModeWarning(config);
  if (warning?.fails) {
    return (
      <span
        className={cn(
          SEND_MODE_BADGE_CLASS,
          "inline-flex items-center border-destructive/40 bg-destructive/5 text-destructive"
        )}
        data-testid="send-mode-warning-badge"
        title={warning.text}
      >
        <AlertTriangle aria-hidden="true" className="size-3" />
        <span className="sr-only">Send as: {warning.text}</span>
      </span>
    );
  }
  const option = sendModeOption(editorSendMode(config));
  if (!(sendsPrivately(config) && option.badge)) {
    return null;
  }
  return (
    <span
      className={cn(
        SEND_MODE_BADGE_CLASS,
        "border-border bg-secondary text-secondary-foreground"
      )}
      data-testid="send-mode-badge"
      title={`Send as: ${option.label}`}
    >
      {option.badge}
      <span className="sr-only">, sent as {option.label}</span>
    </span>
  );
}
