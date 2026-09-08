"use client";

import { ChevronRight, Minus, Pencil, Plus } from "lucide-react";
import { relativeTime } from "@/components/settings/session-format";
import type { SecurityAuditEvent } from "@/lib/api-client";
import { scopeLabel } from "@/lib/mcp/oauth-scopes";
import {
  type AuditActionKind,
  describeAuditAction,
} from "@/lib/security/audit-actions";
import { SENSITIVE_FIELD } from "@/lib/security/audit-redaction";
import { ActorAvatarBadge, ActorIdentity, actorLabel } from "./actor-avatar";

const KIND_ICON: Record<AuditActionKind, typeof Plus> = {
  add: Plus,
  remove: Minus,
  change: Pencil,
};

const KIND_COLOR: Record<AuditActionKind, string> = {
  add: "text-keeperhub-green",
  remove: "text-destructive",
  change: "text-amber-400",
};

function metadataLine(event: SecurityAuditEvent): string | null {
  const meta = event.metadata as Record<string, unknown> | null;
  if (!meta) {
    return null;
  }
  const parts: string[] = [];
  if (typeof meta.ip === "string") {
    parts.push(meta.ip);
  }
  if (typeof meta.country === "string") {
    parts.push(meta.country);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function roleLabel(role?: string | null): string | null {
  return role ? capitalize(role) : null;
}

type DiffEntry = { label: string; from: string | null; to: string | null };

// Opaque machine values that read as noise in a human feed (e.g. a definition
// content hash). The change is still recorded; we just don't print the value.
const HIDDEN_FIELDS = new Set(["contentHash"]);

function humanizeField(path: Array<string | number>): string {
  const key = String(path.at(-1) ?? "");
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "Value";
}

function formatValue(value: unknown, sensitive: boolean): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (sensitive) {
    return "•••";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return "[changed]";
}

type FieldRule = { label: string; isScope?: boolean };

/**
 * Field names that only mean something inside their own subsystem. `scope` and
 * `maxScope` say nothing about agents on their own, and the raw `mcp:write`
 * value is the wire name rather than the one the settings page shows, so both
 * the label and the value are translated. Keyed by resource type, because the
 * same field name means different things elsewhere.
 */
const FIELD_RULES: Record<string, Record<string, FieldRule>> = {
  mcp_connection: {
    clientName: { label: "Agent" },
    scope: { isScope: true, label: "Agent access" },
  },
  mcp_member_scope: {
    scope: { isScope: true, label: "Agent access" },
  },
  mcp_policy: {
    maxScope: { isScope: true, label: "Organization agent limit" },
  },
};

/** An unset limit permits everything, which is what full access means. */
function scopeText(value: unknown): string {
  return typeof value === "string" ? scopeLabel(value) : "Full access";
}

// Turn the stored deep-diff array into readable "Field: old -> new" rows.
function diffEntries(diff: unknown, resourceType: string | null): DiffEntry[] {
  if (!Array.isArray(diff)) {
    return [];
  }
  const entries: DiffEntry[] = [];
  for (const change of diff) {
    if (!change || typeof change !== "object") {
      continue;
    }
    const c = change as {
      kind?: string;
      path?: Array<string | number>;
      lhs?: unknown;
      rhs?: unknown;
    };
    const path = c.path ?? [];
    // Root-level changes (no field path) are whole-object create/delete diffs;
    // the action phrase ("created a project") already says it, so skip them
    // rather than printing "Value: [changed]".
    if (path.length === 0) {
      continue;
    }
    const fieldKey = String(path.at(-1) ?? "");
    if (HIDDEN_FIELDS.has(fieldKey)) {
      continue;
    }
    const sensitive = SENSITIVE_FIELD.test(fieldKey);
    const rule = resourceType ? FIELD_RULES[resourceType]?.[fieldKey] : null;
    const label = rule?.label ?? humanizeField(path);
    // Only an edit has both sides, so only there does an absent value mean
    // "was unlimited" rather than "there was nothing here".
    if (rule?.isScope && c.kind === "E") {
      entries.push({ from: scopeText(c.lhs), label, to: scopeText(c.rhs) });
      continue;
    }
    if (rule?.isScope) {
      entries.push({
        from: c.kind === "D" ? scopeText(c.lhs) : null,
        label,
        to: c.kind === "N" ? scopeText(c.rhs) : null,
      });
      continue;
    }
    if (c.kind === "E") {
      entries.push({
        label,
        from: formatValue(c.lhs, sensitive),
        to: formatValue(c.rhs, sensitive),
      });
    } else if (c.kind === "N") {
      entries.push({ label, from: null, to: formatValue(c.rhs, sensitive) });
    } else if (c.kind === "D") {
      entries.push({ label, from: formatValue(c.lhs, sensitive), to: null });
    }
  }
  return entries.filter((e) => e.from !== null || e.to !== null).slice(0, 6);
}

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

function ValuePiece({ value }: { value: string }): React.ReactElement {
  if (HEX_COLOR.test(value)) {
    return (
      <span
        className="inline-block size-3 rounded-full border border-border align-middle"
        style={{ backgroundColor: value }}
        title={value}
      />
    );
  }
  return <>{value}</>;
}

function DiffLines({
  diff,
  resourceType,
}: {
  diff: unknown;
  resourceType: string | null;
}): React.ReactElement | null {
  const entries = diffEntries(diff, resourceType);
  if (entries.length === 0) {
    return null;
  }
  return (
    <ul className="mt-1 space-y-0.5">
      {entries.map((entry) => (
        <li
          className="text-muted-foreground text-xs"
          key={`${entry.label}:${entry.from ?? ""}:${entry.to ?? ""}`}
        >
          <span className="font-medium text-foreground/70">{entry.label}:</span>{" "}
          {entry.from !== null && (
            <span className="opacity-60">
              <ValuePiece value={entry.from} />
            </span>
          )}
          {entry.from !== null && entry.to !== null && " → "}
          {entry.to !== null && (
            <span>
              <ValuePiece value={entry.to} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

// The workflow definition (nodes/edges/config) is audited as a content hash;
// when it appears in the diff the build itself changed, even if no scalar field
// did. We don't print the hash (it's a HIDDEN_FIELD), so surface a plain note
// instead so the row says what kind of update happened.
function definitionChanged(diff: unknown): boolean {
  if (!Array.isArray(diff)) {
    return false;
  }
  return diff.some((c) => {
    const path = (c as { path?: Array<string | number> })?.path ?? [];
    return String(path.at(-1) ?? "") === "contentHash";
  });
}

// Resource types a feed row can open: workflows go to their editor's version
// History; integrations and API keys open their management modal. Types with no
// such destination (wallet signings, projects, tags) stay non-clickable.
const OPENABLE_TYPES = new Set([
  "workflow",
  "integration",
  "api_key",
  "org_api_key",
]);

export function isOpenableEvent(event: SecurityAuditEvent): boolean {
  return (
    Boolean(event.resourceId) &&
    event.resourceType !== null &&
    OPENABLE_TYPES.has(event.resourceType)
  );
}

export function ActivityRow({
  event,
  onOpen,
}: {
  event: SecurityAuditEvent;
  onOpen?: (event: SecurityAuditEvent) => void;
}): React.ReactElement {
  const { phrase, kind } = describeAuditAction(event.action);
  const Icon = KIND_ICON[kind];
  const meta = metadataLine(event);
  const actor = event.actor;
  const role = roleLabel(actor?.role);
  // Show the email on its own line only when we also have a name -- otherwise
  // actorLabel already falls back to the email.
  const email = actor?.name ? actor.email : null;
  const resourceName = event.resourceName;
  const canOpen = Boolean(onOpen) && isOpenableEvent(event);

  const header = (
    <>
      <div className="flex items-baseline justify-between gap-2 text-sm leading-snug">
        <span className="min-w-0 truncate">
          <span className="font-medium">{actorLabel(actor)}</span>
          {role && (
            <span className="ml-1 text-muted-foreground text-xs">· {role}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground">
          {capitalize(phrase)}
          {/* Always reserve the chevron slot so non-openable rows keep their
              label aligned with openable ones. */}
          {canOpen ? (
            <ChevronRight className="size-3.5" />
          ) : (
            <span aria-hidden="true" className="size-3.5" />
          )}
        </span>
      </div>
      {resourceName && !event.resourceUser && (
        <div className="mt-0.5 truncate font-medium text-foreground/90 text-sm">
          {resourceName}
        </div>
      )}
    </>
  );

  return (
    <li className="flex items-start gap-3 py-3">
      <ActorAvatarBadge
        actor={actor}
        badgeClassName={KIND_COLOR[kind]}
        icon={Icon}
      />
      <div className="min-w-0 flex-1">
        {canOpen ? (
          <button
            className="-mx-1 block w-full rounded px-1 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onOpen?.(event)}
            type="button"
          >
            {header}
          </button>
        ) : (
          header
        )}
        {/* Fixed track for the subject so the rule lands in the same place on
            every row, whatever the change above it says. */}
        <div className="grid grid-cols-1 gap-y-2 sm:grid-cols-[minmax(0,24rem)_minmax(0,14rem)] sm:gap-x-6 sm:gap-y-0">
          <div className="min-w-0">
            <DiffLines diff={event.diff} resourceType={event.resourceType} />
            {definitionChanged(event.diff) && (
              <p className="mt-1 text-muted-foreground text-xs">
                Definition updated
              </p>
            )}
            {email && (
              <p className="truncate text-muted-foreground text-xs">{email}</p>
            )}
            <p className="text-muted-foreground text-xs">
              {relativeTime(event.createdAt)}
              {meta ? ` · ${meta}` : ""}
            </p>
          </div>
          {event.resourceUser && (
            <div className="flex min-w-0 flex-col gap-1 border-border sm:border-l sm:pl-6">
              <span className="text-muted-foreground text-xs">Applied to</span>
              <ActorIdentity actor={event.resourceUser} />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
