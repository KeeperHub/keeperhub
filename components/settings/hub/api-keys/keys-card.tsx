"use client";

import { History, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Pager } from "@/components/activity/pager";
import {
  type ApiKey,
  CreateApiKeyOverlay,
  useApiKeys,
} from "@/components/overlays/api-keys-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { createdFallback } from "@/lib/activity/created-fallback";
import type { SecurityAuditEvent } from "@/lib/api-client";
import { ActivityPanel } from "../activity-panel";
import { EmptyState, SettingsCard } from "../section";
import { TableSkeleton } from "../skeletons";
import { ApiKeysTable } from "./api-keys-table";
import { NewKeyBanner } from "./new-key-banner";

export function KeysCard({
  title,
  description,
  listEndpoint,
  keyType,
  showCreator,
  canManage,
  readOnlyReason,
  activity,
}: {
  title: string;
  description: string;
  listEndpoint: string;
  keyType: "webhook" | "organisation";
  showCreator: boolean;
  canManage: boolean;
  readOnlyReason?: string;
  activity?: { resourceType: string; title: string } | null;
}): React.ReactElement {
  const { push } = useOverlay();
  const deleteEndpoint = (id: string): string => `${listEndpoint}/${id}`;
  const keys = useApiKeys(listEndpoint, deleteEndpoint);
  const [showActivity, setShowActivity] = useState(false);

  const activityFallback: SecurityAuditEvent[] = activity
    ? keys.apiKeys.map((key) =>
        createdFallback({
          createdAt: key.createdAt,
          creator: key.createdByName
            ? {
                email: key.createdByEmail,
                name: key.createdByName,
                role: key.createdByRole,
              }
            : null,
          resourceId: key.id,
          resourceType: activity.resourceType,
        })
      )
    : [];

  return (
    <>
      <SettingsCard
        action={
          <div className="flex items-center gap-2">
            {activity && (
              <Button
                onClick={() => setShowActivity((open) => !open)}
                size="sm"
                variant="ghost"
              >
                <History className="size-3.5" />
                Activity
              </Button>
            )}
            <Button
              disabled={!canManage}
              onClick={() =>
                push(CreateApiKeyOverlay, {
                  endpoint: listEndpoint,
                  keyType,
                  onCreated: (key: ApiKey) => keys.handleKeyCreated(key),
                })
              }
              size="sm"
              variant="outline"
            >
              <Plus className="size-3.5" />
              New key
            </Button>
          </div>
        }
        bodyClassName="p-2"
        description={description}
        title={title}
      >
        {keys.newlyCreatedKey && (
          <NewKeyBanner
            onCopy={() => {
              navigator.clipboard.writeText(keys.newlyCreatedKey ?? "");
              toast.success("Copied to clipboard");
            }}
            onDismiss={keys.dismissNewKey}
            secret={keys.newlyCreatedKey}
          />
        )}

        {keys.loading && <TableSkeleton columns={5} rows={2} />}

        {!keys.loading && keys.apiKeys.length === 0 && (
          <EmptyState>
            {canManage
              ? "No keys yet. Create one to call the API from a script or agent."
              : (readOnlyReason ?? "No keys yet.")}
          </EmptyState>
        )}

        {!keys.loading && keys.apiKeys.length > 0 && (
          <>
            <ApiKeysTable
              apiKeys={keys.apiKeys}
              canDelete={canManage}
              deleteEndpoint={deleteEndpoint}
              onDelete={keys.handleDelete}
              showCreator={showCreator}
              showScope={keyType === "organisation"}
            />
            {keys.meta && keys.meta.totalPages > 1 && (
              <div className="px-2 pt-2">
                <Pager meta={keys.meta} onPage={keys.setPage} unit="keys" />
              </div>
            )}
          </>
        )}

        {!canManage && readOnlyReason && keys.apiKeys.length > 0 && (
          <p className="px-2 pt-2 text-muted-foreground text-xs">
            {readOnlyReason}
          </p>
        )}
      </SettingsCard>

      {showActivity && activity && (
        <ActivityPanel
          fallback={activityFallback}
          onClose={() => setShowActivity(false)}
          params={{ limit: 5, resourceType: activity.resourceType }}
          title={activity.title}
        />
      )}
    </>
  );
}
