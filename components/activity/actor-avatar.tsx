"use client";

import type { LucideIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export type Actor = {
  id?: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  image?: string | null;
};

const WHITESPACE = /\s+/;

export function actorLabel(actor: Actor | null): string {
  return actor?.name || actor?.email || "System";
}

function initials(actor: Actor | null): string {
  const name = actor?.name?.trim();
  if (name) {
    const parts = name.split(WHITESPACE).filter(Boolean);
    const first = parts[0]?.[0] ?? "";
    const second = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
    return (first + second).toUpperCase() || "?";
  }
  const email = actor?.email?.trim();
  return email ? email[0].toUpperCase() : "?";
}

export function ActorAvatar({
  actor,
  className,
}: {
  actor: Actor | null;
  className?: string;
}): React.ReactElement {
  return (
    <Avatar className={cn("size-7", className)}>
      {actor?.image ? (
        <AvatarImage alt={actorLabel(actor)} src={actor.image} />
      ) : null}
      <AvatarFallback className="text-[11px]">{initials(actor)}</AvatarFallback>
    </Avatar>
  );
}

/**
 * Actor avatar with a small corner badge (e.g. an add/change/remove glyph).
 * The badge disc is painted with the page background so it cleanly punches out
 * of the avatar instead of letting it bleed through; `badgeClassName` adds the
 * colored tint + icon color on top of that opaque base.
 */
export function ActorAvatarBadge({
  actor,
  icon: Icon,
  badgeClassName,
}: {
  actor: Actor | null;
  icon: LucideIcon;
  badgeClassName?: string;
}): React.ReactElement {
  return (
    <div className="relative shrink-0">
      <ActorAvatar actor={actor} />
      <span
        className={cn(
          "-right-1 -bottom-1 absolute flex size-4 items-center justify-center rounded-full border border-border bg-card ring-2 ring-background",
          badgeClassName
        )}
      >
        <Icon className="size-2" />
      </span>
    </div>
  );
}

function roleBadgeLabel(role?: string | null): string | null {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : null;
}

/**
 * Compact person identity: avatar + name + org-role badge + email. Reused
 * wherever a member needs to be shown unambiguously (e.g. an actor filter), so
 * "joel" vs "joelorzet" is disambiguated by role + email rather than name alone.
 */
export function ActorIdentity({
  actor,
}: {
  actor: Actor | null;
}): React.ReactElement {
  const name = actorLabel(actor);
  const role = roleBadgeLabel(actor?.role);
  // Only show the email when it isn't already the displayed name.
  const email = actor?.name ? actor.email : null;
  // Avatar on the left; name + role on the first line, email on the second --
  // mirrors the activity-row identity so a person reads unambiguously.
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ActorAvatar actor={actor} className="size-6 shrink-0" />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm">
          <span className="font-medium">{name}</span>
          {role && (
            <span className="text-muted-foreground text-xs"> · {role}</span>
          )}
        </span>
        {email && (
          <span className="truncate text-muted-foreground text-xs">
            {email}
          </span>
        )}
      </div>
    </div>
  );
}
