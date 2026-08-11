"use client";

import type { ProtocolDefinition } from "@/lib/protocol-registry";
import { ProtocolCard } from "./protocol-card";

type ProtocolGridProps = {
  protocols: ProtocolDefinition[];
  searchQuery: string;
  onSelect: (slug: string) => void;
};

export function ProtocolGrid({
  protocols,
  searchQuery,
  onSelect,
}: ProtocolGridProps): React.ReactElement {
  const query = searchQuery.trim().toLowerCase();

  const filtered = query
    ? protocols.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.description.toLowerCase().includes(query)
      )
    : protocols;

  if (protocols.length === 0) {
    return (
      <div>
        <p className="text-muted-foreground">No protocols registered yet.</p>
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div>
        <p className="text-muted-foreground">
          No protocols found matching your search.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {filtered.map((protocol) => (
        <ProtocolCard
          key={protocol.slug}
          onSelect={onSelect}
          protocol={protocol}
        />
      ))}
    </div>
  );
}
