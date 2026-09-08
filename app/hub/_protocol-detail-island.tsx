"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useTransition } from "react";
import { ProtocolDetailModal } from "@/components/hub/protocol-detail-modal";
import type { ProtocolDefinition } from "@/lib/protocol-registry";

type ProtocolDetailIslandProps = {
  protocols: ProtocolDefinition[];
};

export function ProtocolDetailIsland({
  protocols,
}: ProtocolDetailIslandProps): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const selectedSlug = searchParams.get("protocol");
  const selectedProtocol = useMemo(
    () => protocols.find((p) => p.slug === selectedSlug) ?? null,
    [protocols, selectedSlug]
  );

  const handleOpenChange = useCallback(
    (open: boolean): void => {
      if (open) {
        return;
      }
      const params = new URLSearchParams(searchParams.toString());
      params.delete("protocol");
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `/hub?${qs}` : "/hub", { scroll: false });
      });
    },
    [router, searchParams]
  );

  return (
    <ProtocolDetailModal
      onOpenChange={handleOpenChange}
      open={selectedProtocol !== null}
      protocol={selectedProtocol}
    />
  );
}
