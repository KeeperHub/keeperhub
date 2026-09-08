"use client";

import { X } from "lucide-react";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { Button } from "@/components/ui/button";
import type { SecurityAuditEvent } from "@/lib/api-client";
import { SettingsCard } from "./section";

/**
 * An audit trail read inline, beside the thing it describes. This used to be a
 * modal, which put a log nobody can act on over the page it came from.
 */
export function ActivityPanel({
  title,
  fallback,
  params,
  onClose,
}: {
  title: string;
  fallback: SecurityAuditEvent[];
  params: { resourceType: string; resourceId?: string; limit: number };
  onClose: () => void;
}): React.ReactElement {
  return (
    <SettingsCard
      action={
        <Button
          aria-label="Close activity"
          onClick={onClose}
          size="sm"
          variant="ghost"
        >
          <X className="size-3.5" />
          Close
        </Button>
      }
      title={title}
    >
      <ActivityFeed fallback={fallback} params={params} />
    </SettingsCard>
  );
}
