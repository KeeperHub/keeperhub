"use client";

import { History } from "lucide-react";
import { useCallback, useState } from "react";
import {
  describeUserAgent,
  relativeTime,
} from "@/components/settings/session-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

// Mirrors the API response, which is deliberately country-coarse: no IP,
// city, or coordinates are sent to the client.
type MemberSessionRow = {
  id: string;
  userAgent: string | null;
  country: string | null;
  flagged: boolean;
  reasons: string[];
  createdAt: string;
  updatedAt: string;
};

const REGION_NAMES =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(undefined, { type: "region" })
    : null;

// Render a 2-letter code as a country name ("AU" -> "Australia") when the
// platform supports it, otherwise show the code itself.
function countryLabel(code: string | null): string {
  if (!code) {
    return "Location unknown";
  }
  try {
    return REGION_NAMES?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; rows: MemberSessionRow[] }
  | { kind: "error"; message: string };

// Map the internal reason codes the login-risk assessment writes into
// risk_flags_json onto labels an org admin can read at a glance.
const REASON_LABELS: Record<string, string> = {
  new_country: "New country",
  unknown_country: "Unknown location",
  impossible_travel: "Impossible travel",
  first_geo_attestation: "First sign-in location",
};

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

type MemberSessionsDialogProps = {
  organizationId: string;
  memberId: string;
  email: string;
};

/**
 * Owner/admin-only read-only view of one member's recent sessions. Lazily
 * fetches on open from
 * `/api/organizations/{orgId}/members/{memberId}/sessions`, which is gated
 * server-side to org owners/admins; this component is just the surface.
 */
export function MemberSessionsDialog({
  organizationId,
  memberId,
  email,
}: MemberSessionsDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: "idle" });

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      const res = await fetch(
        `/api/organizations/${organizationId}/members/${memberId}/sessions`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setState({
          kind: "error",
          message: data.error ?? "Couldn't load sessions",
        });
        return;
      }
      const data = (await res.json()) as { sessions: MemberSessionRow[] };
      setState({ kind: "ready", rows: data.sessions });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Couldn't load sessions",
      });
    }
  }, [organizationId, memberId]);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      setOpen(next);
      if (next) {
        load();
      } else {
        setState({ kind: "idle" });
      }
    },
    [load]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger asChild>
        <Button
          aria-label={`View ${email}'s sessions`}
          size="icon"
          title="View sessions"
          variant="ghost"
        >
          <History className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Recent sessions</DialogTitle>
          <DialogDescription>
            Where {email} has recently signed in from. Review any location you
            don't recognise.
          </DialogDescription>
        </DialogHeader>

        {state.kind === "loading" && (
          <div className="flex items-center justify-center py-6">
            <Spinner />
          </div>
        )}

        {state.kind === "error" && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-xs">
            {state.message}
          </div>
        )}

        {state.kind === "ready" && state.rows.length === 0 && (
          <p className="py-6 text-center text-muted-foreground text-sm">
            No active sessions.
          </p>
        )}

        {state.kind === "ready" && state.rows.length > 0 && (
          <div className="space-y-2">
            {state.rows.map((row) => {
              const ua = describeUserAgent(row.userAgent);
              const Icon = ua.icon;
              return (
                <div
                  className="flex items-start gap-3 rounded-md border bg-muted/30 p-3"
                  key={row.id}
                >
                  <Icon
                    aria-hidden="true"
                    className="mt-0.5 size-4 text-muted-foreground"
                  />
                  <div className="flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm">{ua.label}</span>
                      {row.flagged &&
                        (row.reasons.length > 0 ? (
                          row.reasons.map((reason) => (
                            <Badge
                              className="h-5 px-1.5 text-[10px]"
                              key={reason}
                              variant="destructive"
                            >
                              {reasonLabel(reason)}
                            </Badge>
                          ))
                        ) : (
                          <Badge
                            className="h-5 px-1.5 text-[10px]"
                            variant="destructive"
                          >
                            Flagged
                          </Badge>
                        ))}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {countryLabel(row.country)}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      Signed in {relativeTime(row.createdAt)} · last active{" "}
                      {relativeTime(row.updatedAt)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
