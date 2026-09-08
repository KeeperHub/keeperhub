"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";
import { ProtocolCardV2 } from "@/components/hub/protocol-card-v2";
import type { ProtocolDefinition } from "@/lib/protocol-registry";

type ProtocolGridClientProps = {
  protocols: ProtocolDefinition[];
  workflowCounts: Record<string, number>;
};

export function ProtocolGridClient({
  protocols,
  workflowCounts,
}: ProtocolGridClientProps): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const handleSelect = useCallback(
    (slug: string): void => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("protocol", slug);
      if (!params.get("tab")) {
        params.set("tab", "protocols");
      }
      startTransition(() => {
        router.replace(`/hub?${params.toString()}`, { scroll: false });
      });
    },
    [router, searchParams]
  );

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
      {protocols.map((protocol) => (
        <ProtocolCardV2
          key={protocol.slug}
          onSelect={handleSelect}
          protocol={protocol}
          workflowCount={workflowCounts[protocol.slug] ?? 0}
        />
      ))}
    </div>
  );
}
