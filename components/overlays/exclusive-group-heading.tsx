"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  ExclusiveGroup,
  ExclusiveGroupState,
} from "@/lib/integrations/exclusive-groups";

/**
 * The divider that opens one of a connection's alternative credentials, and
 * says which one is in use.
 *
 * The escape hatch matters as much as the lock. Holding the other alternative
 * shut makes "one or the other" obvious, but on its own it would trap somebody
 * who filled in the wrong one: the only way back would be to empty every field
 * of the first by hand, and on a password field they cannot even see what is
 * there. So a held-shut group offers to clear the one in use and take over.
 */
export function ExclusiveGroupHeading({
  group,
  state,
  onUseThisInstead,
}: {
  group: ExclusiveGroup;
  state: ExclusiveGroupState;
  onUseThisInstead: (group: ExclusiveGroup) => void;
}) {
  const locked =
    Boolean(state.activeGroupId) &&
    !state.ambiguous &&
    group.id !== state.activeGroupId;
  const active = group.id === state.activeGroupId && !state.ambiguous;
  const inUse = state.groups.find((one) => one.id === state.activeGroupId);

  return (
    <div className="space-y-1.5 pt-2">
      <div className="flex items-center gap-2">
        <div className="h-px flex-grow bg-border" />
        <span
          className={`font-medium text-xs uppercase tracking-wide ${
            locked ? "text-muted-foreground/60" : "text-muted-foreground"
          }`}
        >
          {group.label}
        </span>
        <div className="h-px flex-grow bg-border" />
      </div>

      {/* Always present, and reserving the taller state's height, so neither
          message moves the fields below it. A minimum rather than a fixed
          height: the locked line plus its button is not a short row, and in a
          flyout it wraps - which a fixed height would push over whatever sits
          under it. */}
      <div className="flex min-h-8 flex-wrap items-center justify-center gap-2">
        {active && (
          <p className="text-muted-foreground text-xs">
            In use. You do not need to fill in the other option.
          </p>
        )}
        {locked && (
          <>
            <p className="text-muted-foreground text-xs">
              Not needed - {inUse?.label ?? "the other option"} is in use.
            </p>
            <Button
              onClick={() => onUseThisInstead(group)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Use this instead
            </Button>
          </>
        )}
      </div>

      {state.ambiguous && group.id === state.groups[0]?.id && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <p>
            Both options are filled in. Only {state.groups[0]?.label} is used -
            clear it if you meant to use the other one.
          </p>
        </div>
      )}
    </div>
  );
}
