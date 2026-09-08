"use client";

import { ActivityFeed } from "@/components/activity/activity-feed";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { createdFallback } from "@/lib/activity/created-fallback";
import type { SecurityAuditEvent } from "@/lib/api-client";

type ActorInfo = {
  name?: string | null;
  email?: string | null;
  role?: string | null;
};

type KeyForFallback = {
  id: string;
  createdAt: string;
  createdByName?: string | null;
  createdByEmail?: string | null;
  createdByRole?: string | null;
};

type KeyActivityOverlayProps = {
  overlayId: string;
  // The audit resourceType to filter on: "org_api_key" or "api_key".
  resourceType: string;
  title?: string;
  // Current keys, used to synthesize a "created" entry for keys that predate
  // audit logging (so the trail isn't empty for an existing key).
  keys?: KeyForFallback[];
  // Actor to attribute fallback entries to when the key row has no creator
  // (e.g. the current user for their own webhook keys).
  defaultActor?: ActorInfo | null;
};

/**
 * Standalone modal listing the create/revoke activity for a set of API keys,
 * pushed from the API-keys overlay. Each row identifies the actor (name, org
 * role, email) so same-named users are distinguishable. Existing keys with no
 * recorded event fall back to a synthesized "created" entry carrying the same
 * actor identity.
 */
export function KeyActivityOverlay({
  overlayId,
  resourceType,
  title = "Key activity",
  keys,
  defaultActor,
}: KeyActivityOverlayProps): React.ReactElement {
  const { pop } = useOverlay();
  const fallback: SecurityAuditEvent[] = (keys ?? []).map((k) => {
    const source: ActorInfo | null = k.createdByName
      ? { name: k.createdByName, email: k.createdByEmail, role: k.createdByRole }
      : (defaultActor ?? null);
    return createdFallback({
      resourceType,
      resourceId: k.id,
      createdAt: k.createdAt,
      creator: source,
    });
  });
  return (
    <Overlay
      actions={[{ label: "Done", onClick: pop }]}
      overlayId={overlayId}
      title={title}
    >
      <ActivityFeed fallback={fallback} params={{ resourceType, limit: 5 }} />
    </Overlay>
  );
}
