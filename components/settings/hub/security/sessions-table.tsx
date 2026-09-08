"use client";

import { describeUserAgent } from "@/components/settings/session-format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SessionRow } from "../hooks/use-security";
import { SETTINGS_HEAD_ROW, SETTINGS_ROW } from "../section";

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) {
    return "Just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

export function SessionsTable({
  sessions,
  onRevoke,
}: {
  sessions: SessionRow[];
  onRevoke: (session: SessionRow) => void;
}): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow className={SETTINGS_HEAD_ROW}>
          <TableHead>Device</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Last active</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((session) => {
          const device = describeUserAgent(session.userAgent);
          return (
            <TableRow className={SETTINGS_ROW} key={session.id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <device.icon className="size-4" />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2 truncate font-medium">
                      {device.label}
                      {session.isCurrent && (
                        <span className="rounded-full border px-2 py-0.5 text-[0.6875rem]">
                          This device
                        </span>
                      )}
                    </span>
                    <span className="truncate font-mono text-muted-foreground text-xs">
                      {session.ipAddress ?? "Unknown IP"}
                    </span>
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {session.location ?? session.country ?? "Unknown"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {relative(session.updatedAt)}
              </TableCell>
              <TableCell className="text-right">
                {!session.isCurrent && (
                  <button
                    className="text-destructive text-sm hover:underline"
                    onClick={() => onRevoke(session)}
                    type="button"
                  >
                    Revoke
                  </button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
