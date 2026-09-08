"use client";

import { Trash2 } from "lucide-react";
import {
  type ApiKey,
  DeleteApiKeyOverlay,
} from "@/components/overlays/api-keys-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { roleLabel } from "@/lib/organization/role-label";
import { SETTINGS_HEAD_ROW, SETTINGS_ROW } from "../section";

function formatDate(value: string | null): string {
  if (!value) {
    return "Never";
  }
  return new Date(value).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

type DeleteFn = (
  keyId: string,
  code: string,
  emailOtp: string
) => Promise<{ ok: true } | { ok: false; code: string }>;

const SCOPE_SEPARATOR = /[\s,]+/;

export function ApiKeysTable({
  apiKeys,
  showCreator,
  showScope,
  canDelete,
  deleteEndpoint,
  onDelete,
}: {
  apiKeys: ApiKey[];
  showCreator: boolean;
  /**
   * Webhook (wfb_) keys store a scope nothing reads -- the workflow webhook
   * route matches on the key hash and dispatches without consulting it -- so
   * the column is dropped rather than reporting a restriction that is not
   * applied.
   */
  showScope: boolean;
  canDelete: boolean;
  deleteEndpoint: (id: string) => string;
  onDelete: DeleteFn;
}): React.ReactElement {
  const { push } = useOverlay();

  return (
    <Table>
      <TableHeader>
        <TableRow className={SETTINGS_HEAD_ROW}>
          <TableHead>Key</TableHead>
          {showScope && <TableHead>Scopes</TableHead>}
          {showCreator && <TableHead>Created by</TableHead>}
          <TableHead>Last used</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {apiKeys.map((key) => (
          <TableRow className={SETTINGS_ROW} key={key.id}>
            <TableCell>
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium">
                  {key.name || "Untitled key"}
                </span>
                <span className="truncate font-mono text-muted-foreground text-xs">
                  {key.keyPrefix}...
                </span>
              </div>
            </TableCell>
            {showScope && (
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {(key.scope ?? "")
                    .split(SCOPE_SEPARATOR)
                    .filter(Boolean)
                    .map((scope) => (
                      <span
                        className="rounded-full border px-2 py-0.5 font-mono text-[0.6875rem]"
                        key={scope}
                      >
                        {scope}
                      </span>
                    ))}
                  {/* A null scope column is full access, not none. "--" read as
                      "no permissions" -- the opposite of what it means. */}
                  {!key.scope && (
                    <span className="text-muted-foreground text-xs">
                      unrestricted
                    </span>
                  )}
                </div>
              </TableCell>
            )}
            {showCreator && (
              <TableCell>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {key.createdByName || key.createdByEmail || "Unknown"}
                  </span>
                  {key.createdByRole && (
                    <span className="text-muted-foreground text-xs">
                      {roleLabel(key.createdByRole)}
                    </span>
                  )}
                </div>
              </TableCell>
            )}
            <TableCell className="text-muted-foreground">
              {formatDate(key.lastUsedAt)}
            </TableCell>
            <TableCell className="text-right">
              {canDelete && (
                <Button
                  aria-label={`Revoke ${key.name || "key"}`}
                  onClick={() =>
                    push(DeleteApiKeyOverlay, {
                      deleteEndpoint,
                      keyId: key.id,
                      onDelete,
                    })
                  }
                  size="icon"
                  variant="ghost"
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
