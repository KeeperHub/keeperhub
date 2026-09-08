"use client";

import { ActivityFeed } from "@/components/activity/activity-feed";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { createdFallback } from "@/lib/activity/created-fallback";
import type { SecurityAuditEvent } from "@/lib/api-client";

export type ResourceActivityCreator = {
  name: string | null;
  email: string | null;
  role: string | null;
};

/**
 * Activity history (created / updated / deleted) for a single resource,
 * pushed from a manager list. Mirrors IntegrationActivityOverlay: each row
 * identifies the actor; a resource that predates audit logging falls back to
 * a synthesized "created" entry built from its creation record.
 */
export function ResourceActivityOverlay({
  overlayId,
  title,
  resourceType,
  resourceId,
  createdAction,
  createdAt,
  creator,
}: {
  overlayId: string;
  title: string;
  resourceType: string;
  resourceId: string;
  createdAction: string;
  createdAt: string;
  creator: ResourceActivityCreator;
}): React.ReactElement {
  const { pop } = useOverlay();
  const fallback: SecurityAuditEvent[] = [
    createdFallback({
      resourceType,
      resourceId,
      createdAt,
      action: createdAction,
      creator,
    }),
  ];
  return (
    <Overlay
      actions={[{ label: "Done", onClick: pop }]}
      overlayId={overlayId}
      title={title}
    >
      <ActivityFeed
        fallback={fallback}
        params={{ resourceType, resourceId, limit: 5 }}
      />
    </Overlay>
  );
}
