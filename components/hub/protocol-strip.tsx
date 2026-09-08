"use client";

import { Box } from "lucide-react";
import Image from "next/image";
import type { ProtocolDefinition } from "@/lib/protocol-registry";

type ProtocolStripProps = {
  protocols: ProtocolDefinition[];
  onSelect: (slug: string) => void;
};

export function ProtocolStrip({
  protocols,
  onSelect,
}: ProtocolStripProps): React.ReactElement | null {
  if (protocols.length === 0) {
    return null;
  }

  return (
    <section aria-label="Protocols" className="py-2">
      <div className="mb-3 flex items-center gap-3">
        <div className="h-px flex-1 bg-border/30" />
        <h2 className="shrink-0 text-[var(--color-text-accent)]/60 text-xs uppercase tracking-widest">
          Protocols
        </h2>
        <div className="h-px flex-1 bg-border/30" />
      </div>

      <div className="flex flex-wrap gap-2">
        {protocols.map((protocol) => {
          const actionCount = protocol.actions.length;

          return (
            <button
              className="flex items-center gap-2 rounded-lg border border-border/30 bg-[var(--color-hub-card)] px-3 py-2 text-left transition-all hover:border-border/60 hover:bg-[var(--color-hub-icon-bg)] motion-reduce:transition-none"
              key={protocol.slug}
              onClick={() => onSelect(protocol.slug)}
              type="button"
            >
              <div className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-hub-icon-bg)]">
                {protocol.icon ? (
                  <Image
                    alt={protocol.name}
                    className="rounded-sm"
                    height={16}
                    src={protocol.icon}
                    width={16}
                  />
                ) : (
                  <Box className="size-3.5 text-[var(--color-text-accent)]" />
                )}
              </div>
              <span className="font-medium text-xs">{protocol.name}</span>
              <span className="text-muted-foreground/50 text-[10px]">
                {actionCount}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
