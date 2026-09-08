"use client";

import { Box, Workflow as WorkflowIcon } from "lucide-react";
import Image from "next/image";
import type { KeyboardEvent } from "react";
import type { ProtocolDefinition } from "@/lib/protocol-registry";

type ProtocolCardV2Props = {
  protocol: ProtocolDefinition;
  workflowCount: number;
  onSelect: (slug: string) => void;
};

function capabilityLabel(
  protocol: ProtocolDefinition,
  workflowCount: number
): string {
  const parts: string[] = [];
  if (protocol.actions.length > 0) {
    parts.push("Actions");
  }
  if (protocol.events && protocol.events.length > 0) {
    parts.push("Events");
  }
  if (workflowCount > 0) {
    parts.push("Workflows");
  }
  if (parts.length === 0) {
    return "Coming soon";
  }
  return `View ${parts.join(", ")}`;
}

export function ProtocolCardV2({
  protocol,
  workflowCount,
  onSelect,
}: ProtocolCardV2Props): React.ReactElement {
  const handleClick = (): void => {
    onSelect(protocol.slug);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(protocol.slug);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: card uses an <article> with role="link" + ::before overlay per UI-SPEC §1; wrapping <a> is forbidden to preserve nested-button A11y
    <article
      aria-label={`Open ${protocol.name} details`}
      className="group relative flex min-h-[180px] cursor-pointer flex-col rounded-xl border border-border/20 bg-[var(--color-hub-card)] p-4 shadow-sm transition-colors duration-150 before:absolute before:inset-0 before:z-[1] before:cursor-pointer before:rounded-xl before:content-[''] hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-hub-overlay)] motion-reduce:transition-none"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: UI-SPEC §1 mandates <article role="link"> for the card; click is delivered via the ::before overlay and onKeyDown handler.
      role="link"
      tabIndex={0}
    >
      <div className="pointer-events-none relative z-[2] flex size-12 items-center justify-center rounded-lg bg-[var(--color-hub-icon-bg)]">
        {protocol.icon ? (
          <Image
            alt=""
            className="size-8 object-contain"
            height={32}
            src={protocol.icon}
            width={32}
          />
        ) : (
          <Box
            aria-hidden="true"
            className="size-6 text-[var(--color-text-accent)]"
          />
        )}
      </div>

      <h3 className="pointer-events-none relative z-[2] mt-3 line-clamp-2 font-semibold text-foreground text-sm">
        {protocol.name}
      </h3>

      <p className="pointer-events-none relative z-[2] mt-1.5 line-clamp-3 text-muted-foreground/80 text-xs">
        {protocol.description}
      </p>

      <div className="pointer-events-none relative z-[2] mt-auto flex items-center gap-2 pt-3">
        <WorkflowIcon
          aria-hidden="true"
          className="size-3.5 text-muted-foreground"
        />
        <span className="text-muted-foreground text-xs">
          {capabilityLabel(protocol, workflowCount)}
        </span>
      </div>
    </article>
  );
}
