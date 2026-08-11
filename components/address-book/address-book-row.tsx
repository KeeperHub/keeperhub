"use client";

import { Copy, Edit, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toChecksumAddress, truncateAddress } from "@/lib/address-utils";
import type { AddressBookEntry } from "@/lib/api-client";

type AddressBookRowProps = {
  entry: AddressBookEntry;
  onUpdate: () => void;
  onDelete: () => void;
  onEdit: (entry: AddressBookEntry) => void;
  deleting: string | null;
};

export function AddressBookRow({
  entry,
  onDelete,
  onEdit,
  deleting,
}: AddressBookRowProps) {
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  return (
    <TableRow>
      <TableCell className="max-w-40 font-medium">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block truncate">{entry.label}</span>
          </TooltipTrigger>
          <TooltipContent align="center" side="left">
            {entry.label}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {truncateAddress(entry.address, 12)}
          </code>
          <Button
            onClick={() => copyToClipboard(toChecksumAddress(entry.address))}
            size="sm"
            variant="ghost"
          >
            <Copy className="h-4 w-4" />
          </Button>
        </div>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2">
          <Button
            disabled={deleting === entry.id}
            onClick={() => onEdit(entry)}
            size="sm"
            variant="ghost"
          >
            <Edit className="h-4 w-4" />
          </Button>
          <Button
            disabled={deleting === entry.id}
            onClick={onDelete}
            size="sm"
            variant="ghost"
          >
            {deleting === entry.id ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <Trash2 className="h-4 w-4 text-destructive" />
            )}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
