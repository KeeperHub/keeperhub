"use client";

import { Download } from "lucide-react";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { AuditFilterBar } from "@/components/activity/audit-filter-bar";
import { ExportAuditOverlay } from "@/components/overlays/export-audit-overlay";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PAGE_SIZE_OPTIONS,
  useAuditActivity,
} from "@/lib/hooks/use-audit-activity";
import { useActiveMember } from "@/lib/hooks/use-organization";
import { Overlay } from "./overlay";
import { useOverlay } from "./overlay-provider";

/**
 * Organization-wide security activity feed. Surfaced from the left nav (owners
 * and admins only -- the read endpoint is gated the same way server-side).
 * Filter builder + page-size control + the feed; export is owner-only and
 * dual-factor gated via ExportAuditOverlay.
 */
export function ActivityOverlay({
  overlayId,
}: {
  overlayId: string;
}): React.ReactElement {
  const { pop, push } = useOverlay();
  const { isOwner } = useActiveMember();
  const activity = useAuditActivity();

  return (
    <Overlay
      actions={[{ label: "Done", onClick: pop }]}
      description="Recent security-sensitive actions across your organization."
      overlayId={overlayId}
      title="Organization activity"
    >
      <div className="flex items-center justify-end">
        <Button
          disabled={!isOwner}
          onClick={() =>
            push(ExportAuditOverlay, { resourceTypes: activity.types })
          }
          size="sm"
          title={isOwner ? undefined : "Only organization owners can export"}
          variant="outline"
        >
          <Download className="mr-2 size-4" />
          Export CSV
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <AuditFilterBar activity={activity} />
        <Select
          onValueChange={(v) => activity.setPageSize(Number(v))}
          value={String(activity.pageSize)}
        >
          <SelectTrigger className="h-8 w-[110px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size} / page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3">
        <ActivityFeed embedded params={activity.feedParams} />
      </div>
    </Overlay>
  );
}
