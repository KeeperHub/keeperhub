"use client";

import { ActivityFeed } from "@/components/activity/activity-feed";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { createdFallback } from "@/lib/activity/created-fallback";
import type { Integration, SecurityAuditEvent } from "@/lib/api-client";

/**
 * Activity history (created / updated / deleted) for a single integration,
 * pushed from the integrations manager. Mirrors KeyActivityOverlay: each row
 * identifies the actor; an integration that predates audit logging falls back
 * to a synthesized "added" entry from its creation record.
 */
export function IntegrationActivityOverlay({
  overlayId,
  integration,
}: {
  overlayId: string;
  integration: Integration;
}): React.ReactElement {
  const { pop } = useOverlay();
  const typeLabel =
    integration.type.charAt(0).toUpperCase() + integration.type.slice(1);
  const resourceName =
    integration.name.trim() &&
    integration.name.toLowerCase() !== integration.type.toLowerCase()
      ? `${integration.name} · ${typeLabel}`
      : typeLabel;
  const fallback: SecurityAuditEvent[] = [
    createdFallback({
      resourceType: "integration",
      resourceId: integration.id,
      resourceName,
      createdAt: integration.createdAt,
      creator: {
        name: integration.createdByName,
        email: integration.createdByEmail,
        role: integration.createdByRole,
      },
    }),
  ];
  return (
    <Overlay
      actions={[{ label: "Done", onClick: pop }]}
      overlayId={overlayId}
      title={`Activity: ${integration.name}`}
    >
      <ActivityFeed
        fallback={fallback}
        params={{
          resourceType: "integration",
          resourceId: integration.id,
          limit: 5,
        }}
      />
    </Overlay>
  );
}
