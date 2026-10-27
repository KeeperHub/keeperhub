"use client";

import { ChevronRight, Plug, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { relativeTime } from "@/components/settings/session-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  effectiveScope,
  SUPPORTED_SCOPES,
  scopeExceeds,
  scopeLabel,
} from "@/lib/mcp/oauth-scopes";
import { cn } from "@/lib/utils";
import { ConfirmDeleteDialog } from "../confirm-delete-dialog";
import type {
  McpConnectionRow,
  McpUserGroup,
} from "../hooks/use-mcp-connections";
import {
  NARROW_ONLY,
  NARROW_SR_ONLY,
  SETTINGS_HEAD_ROW,
  SETTINGS_ROW,
} from "../section";

// In a narrow column a person's access and last use sit under their name,
// past the chevron, and a session's under its own indented name.
const UNDER_PERSON = "@max-xl/settings:pl-8";
const UNDER_SESSION = "@max-xl/settings:pl-10";

const SKELETON_ROWS = ["a", "b", "c"] as const;

/** An unset ceiling permits everything, which is what full access means. */
const UNSET_READS_AS = "mcp:admin";

/**
 * Whether this agent can still reach us. A session lives until its credential
 * runs out or somebody ends it, so an expired one stays listed but is not
 * connected to anything.
 */
function ConnectedBadge({
  session,
}: {
  session: McpConnectionRow;
}): React.ReactElement {
  const live = new Date(session.expiresAt).getTime() > Date.now();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-xs",
        live
          ? "border-keeperhub-green/20 bg-keeperhub-green/10 text-keeperhub-green"
          : "border-border bg-muted/40 text-muted-foreground"
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          live ? "bg-keeperhub-green" : "bg-muted-foreground/60"
        )}
      />
      {live ? "Connected" : "Expired"}
    </span>
  );
}

function LastUsed({
  session,
}: {
  session: McpConnectionRow;
}): React.ReactElement {
  if (!session.lastUsedAt) {
    return <span className="text-muted-foreground text-xs">Not used yet</span>;
  }
  return (
    <span className="text-muted-foreground text-xs">
      <span className={NARROW_ONLY}>Last used </span>
      {relativeTime(session.lastUsedAt)}
    </span>
  );
}

/** The most recent moment any of this person's sessions was used. */
function lastUsedAcross(group: McpUserGroup): string | null {
  let latest: string | null = null;
  for (const session of group.sessions) {
    if (session.lastUsedAt && (!latest || session.lastUsedAt > latest)) {
      latest = session.lastUsedAt;
    }
  }
  return latest;
}

/** "2 sessions", or that there is nothing connected yet. */
function sessionSummary(group: McpUserGroup): string {
  if (group.sessions.length === 0) {
    return "No agents connected";
  }
  return group.sessions.length === 1
    ? "1 session"
    : `${group.sessions.length} sessions`;
}

/**
 * Narrows a group to what the term asked for, or null when it asked for
 * something this person does not have.
 *
 * Naming the person keeps all of their sessions, because the question was about
 * them. Naming a session keeps that one: searching an id and being shown the
 * others defeats the point of searching for it. The person's row stays either
 * way, since a session on its own says nothing about whose it is.
 */
function narrow(group: McpUserGroup, term: string): McpUserGroup | null {
  if (!term) {
    return group;
  }
  const needle = term.toLowerCase();
  if (
    group.userName.toLowerCase().includes(needle) ||
    group.userEmail.toLowerCase().includes(needle)
  ) {
    return group;
  }
  const sessions = group.sessions.filter(
    (session) =>
      session.clientName.toLowerCase().includes(needle) ||
      session.clientId.toLowerCase().includes(needle)
  );
  return sessions.length > 0 ? { ...group, sessions } : null;
}

export function ConnectionsTable({
  users,
  canManage,
  maxScope,
  loading,
  busyId,
  onRevoke,
  onScopeChange,
}: {
  users: McpUserGroup[];
  /** Admins and owners set access; everyone may end their own sessions. */
  canManage: boolean;
  /** The organization ceiling. Levels above it are shown but not selectable. */
  maxScope: string | null;
  loading: boolean;
  busyId: string | null;
  onRevoke: (session: McpConnectionRow) => void;
  onScopeChange: (group: McpUserGroup, scope: string) => void;
}): React.ReactElement {
  const [term, setTerm] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<McpConnectionRow | null>(null);

  const shown = useMemo(
    () =>
      users
        .map((group) => narrow(group, term))
        .filter((group): group is McpUserGroup => group !== null),
    [users, term]
  );

  const toggle = (userId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  if (!loading && users.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <Plug className="size-6 text-muted-foreground" />
        <span className="font-medium text-sm">No agents connected yet</span>
        <span className="max-w-sm text-muted-foreground text-xs">
          Run the command for your client below and sign in. It appears here the
          moment it connects.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative max-w-xs">
        <Search className="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
        <Input
          className="h-9 pl-8"
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search people or sessions"
          value={term}
        />
      </div>

      {/* Fixed widths, so a long address is cut short in its own column
          rather than widening the table past the card. The other columns
          take only what their longest value needs, since the first one gets
          what is left of a table that can be as narrow as 36rem. */}
      <Table className="table-fixed">
        <TableHeader>
          <TableRow className={SETTINGS_HEAD_ROW}>
            <TableHead className="truncate">Person and sessions</TableHead>
            <TableHead className="w-44">Access</TableHead>
            <TableHead className="w-28">Last used</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            SKELETON_ROWS.map((key) => (
              <TableRow key={key}>
                <TableCell colSpan={4} role="cell">
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            ))}

          {!loading && shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} role="cell">
                <span className="block py-6 text-center text-muted-foreground text-xs">
                  Nothing matches that.
                </span>
              </TableCell>
            </TableRow>
          )}

          {!loading &&
            shown.map((group) => {
              // Somebody with no agent connected still gets a row: an admin
              // sets their limit before they connect, not after.
              const hasSessions = group.sessions.length > 0;
              const isOpen = hasSessions && !collapsed.has(group.userId);
              return [
                <TableRow
                  className={SETTINGS_ROW}
                  key={group.userId}
                  role="row"
                >
                  <TableCell role="cell">
                    {/* A button is as wide as its text unless capped, which
                        would leave the lines inside nothing to cut short. */}
                    <button
                      aria-expanded={isOpen}
                      className="flex min-w-0 max-w-full items-center gap-2 text-left"
                      disabled={!hasSessions}
                      onClick={() => toggle(group.userId)}
                      type="button"
                    >
                      <ChevronRight
                        className={cn(
                          "size-4 shrink-0 transition-transform",
                          hasSessions
                            ? "text-muted-foreground"
                            : "text-transparent",
                          isOpen && "rotate-90"
                        )}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">
                          {group.userName || group.userEmail}
                        </span>
                        {/* The address gives way, not what is connected. */}
                        <span className="flex min-w-0 gap-1 text-muted-foreground text-xs">
                          <span className="truncate">{group.userEmail}</span>
                          <span className="shrink-0">
                            · {sessionSummary(group)}
                          </span>
                        </span>
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className={UNDER_PERSON} role="cell">
                    {canManage && group.canEdit ? (
                      <Select
                        disabled={busyId === group.userId}
                        onValueChange={(next) => onScopeChange(group, next)}
                        value={group.maxScope ?? UNSET_READS_AS}
                      >
                        <SelectTrigger aria-label="Access" className="h-8 w-40">
                          <SelectValue />
                        </SelectTrigger>
                        {/* The label stays plain: the trigger renders the
                            selected item's own text, so a reason tacked onto it
                            would read back as the person's access. */}
                        <SelectContent>
                          {SUPPORTED_SCOPES.map((scope) => (
                            <SelectItem
                              disabled={scopeExceeds(scope, maxScope)}
                              key={scope}
                              value={scope}
                            >
                              {scopeLabel(scope)}
                            </SelectItem>
                          ))}
                          {maxScope && (
                            <span className="block border-t px-2 py-1.5 text-muted-foreground text-xs">
                              This organization allows at most{" "}
                              {scopeLabel(maxScope)}.
                            </span>
                          )}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-sm @xl/settings:pl-3">
                        <span className={NARROW_SR_ONLY}>Access </span>
                        {scopeLabel(group.maxScope ?? UNSET_READS_AS)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className={UNDER_PERSON} role="cell">
                    {(() => {
                      const latest = lastUsedAcross(group);
                      return (
                        <span className="text-muted-foreground text-xs">
                          {latest && (
                            <span className={NARROW_ONLY}>Last used </span>
                          )}
                          {latest ? relativeTime(latest) : "Not used yet"}
                        </span>
                      );
                    })()}
                  </TableCell>
                  <TableCell role="cell" />
                </TableRow>,

                ...(isOpen ? group.sessions : []).map((session) => (
                  <TableRow
                    className={SETTINGS_ROW}
                    key={session.id}
                    role="row"
                  >
                    <TableCell className="pl-10" role="cell">
                      <div className="flex min-w-0 flex-col">
                        {/* Where both do not fit, the badge drops under the
                            name rather than squeezing it to nothing. */}
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                          <span className="truncate">{session.clientName}</span>
                          <ConnectedBadge session={session} />
                        </span>
                        {/* Each `mcp add` registers a fresh client, so one tool
                            can hold several sessions under the same name. The
                            client id is what tells them apart, and it is public
                            in OAuth, so a leading fragment is safe to show. */}
                        <span className="flex min-w-0 gap-1 text-muted-foreground text-xs">
                          <span className="truncate">
                            Connected {relativeTime(session.connectedAt)} ·
                          </span>
                          <span className="shrink-0 font-mono">
                            {session.clientId.slice(0, 8)}
                          </span>
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className={UNDER_SESSION} role="cell">
                      {/* In the wide layout, padded to the select trigger above
                          it, so the session's level lines up with the person's.
                          Stacked in a narrow column it lines up with the lines
                          around it instead. */}
                      <span className="text-muted-foreground text-xs @xl/settings:pl-3">
                        <span className={NARROW_SR_ONLY}>Access </span>
                        {scopeLabel(effectiveScope(session.scope))}
                      </span>
                    </TableCell>
                    <TableCell className={UNDER_SESSION} role="cell">
                      <LastUsed session={session} />
                    </TableCell>
                    <TableCell className="text-right" role="cell">
                      <Button
                        className="h-7 text-xs"
                        disabled={busyId === session.id}
                        onClick={() => setPending(session)}
                        size="sm"
                        variant="outline"
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                )),
              ];
            })}
        </TableBody>
      </Table>

      <ConfirmDeleteDialog
        confirmLabel="Revoke"
        description={`${pending?.clientName ?? "This agent"} stops working straight away and has to be connected again to come back.`}
        onConfirm={() => {
          if (pending) {
            onRevoke(pending);
          }
        }}
        onOpenChange={(next) => !next && setPending(null)}
        open={pending !== null}
        title="Revoke this session"
      />
    </div>
  );
}
