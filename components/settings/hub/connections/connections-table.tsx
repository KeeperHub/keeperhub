"use client";

import { History, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { IntegrationIcon } from "@/components/ui/integration-icon";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Integration } from "@/lib/api-client";
import { ConfirmDeleteDialog } from "../confirm-delete-dialog";
import type { LabelledIntegration } from "../hooks/use-connections";
import { SETTINGS_HEAD_ROW, SETTINGS_ROW } from "../section";

export function ConnectionsTable({
  connections,
  canManage,
  onEdit,
  onRemove,
  onShowActivity,
}: {
  connections: LabelledIntegration[];
  canManage: boolean;
  onEdit: (integration: Integration) => void;
  onRemove: (integration: Integration) => Promise<void>;
  onShowActivity: (integration: Integration) => void;
}): React.ReactElement {
  const [pending, setPending] = useState<LabelledIntegration | null>(null);

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className={SETTINGS_HEAD_ROW}>
            <TableHead>Service</TableHead>
            <TableHead>Label</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((connection) => (
            <TableRow className={SETTINGS_ROW} key={connection.id}>
              <TableCell>
                <span className="flex items-center gap-2.5 font-medium">
                  <IntegrationIcon
                    className="size-4 shrink-0"
                    integration={connection.type}
                  />
                  {connection.label}
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {connection.name}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    aria-label="Activity"
                    onClick={() => onShowActivity(connection)}
                    size="icon"
                    variant="ghost"
                  >
                    <History className="size-4" />
                  </Button>
                  {canManage && (
                    <>
                      <Button
                        aria-label="Edit"
                        onClick={() => onEdit(connection)}
                        size="icon"
                        variant="ghost"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        aria-label="Remove"
                        onClick={() => setPending(connection)}
                        size="icon"
                        variant="ghost"
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ConfirmDeleteDialog
        description={`Workflows using ${pending?.name ?? "this connection"} stop being able to authenticate with it.`}
        onConfirm={async () => {
          if (pending) {
            await onRemove(pending);
          }
        }}
        onOpenChange={(next) => !next && setPending(null)}
        open={pending !== null}
        title="Remove connection"
      />
    </>
  );
}
