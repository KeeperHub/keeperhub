"use client";

import { Gem, Info } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isBillingEnabled } from "@/lib/billing/feature-flag";
import {
  DIGEST_REQUIRES_CADENCE_ERROR,
  DIGEST_REQUIRES_SUBSCRIBER_ERROR,
} from "@/lib/notifications/digest-messages";

type Cadence = "daily" | "weekly" | "monthly";

const CADENCE_OPTIONS: { value: Cadence; label: string; hint: string }[] = [
  { value: "daily", label: "Daily", hint: "Sent every day at 14:00 UTC." },
  {
    value: "weekly",
    label: "Weekly",
    hint: "Sent every Tuesday at 14:00 UTC.",
  },
  {
    value: "monthly",
    label: "Monthly",
    hint: "Sent on the 1st of each month at 14:00 UTC.",
  },
];

type DigestMember = {
  userId: string;
  role: string;
  email: string | null;
  name: string | null;
};

type DigestSettingsResponse = {
  enabled: boolean;
  cadences: Cadence[];
  subscriberUserIds: string[];
  eligible: boolean;
  members: DigestMember[];
};

type ExecutionDigestSectionProps = {
  organizationId: string;
  canManageBilling: boolean;
};

/** Stable shape for comparing the form against what is persisted. */
function serialiseDigest(
  enabled: boolean,
  cadences: Set<Cadence>,
  subscribers: Set<string>
): string {
  return JSON.stringify({
    cadences: [...cadences].sort(),
    enabled,
    subscribers: [...subscribers].sort(),
  });
}

export function ExecutionDigestSection({
  organizationId,
  canManageBilling,
}: ExecutionDigestSectionProps): React.ReactElement {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  // Entitlement is per-org (the API checks this org's plan), not the active
  // org's, so a digest-email deep link to another org gates correctly.
  const [eligible, setEligible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [cadences, setCadences] = useState<Set<Cadence>>(new Set(["weekly"]));
  const [subscribers, setSubscribers] = useState<Set<string>>(new Set());
  const [members, setMembers] = useState<DigestMember[]>([]);
  // Snapshot of the persisted values, so the form can tell you when it is
  // holding changes you have not saved yet.
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/organizations/${organizationId}/execution-digest`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: DigestSettingsResponse | null) => {
        if (!(active && data)) {
          return;
        }
        setEnabled(data.enabled);
        setCadences(new Set(data.cadences));
        setSubscribers(new Set(data.subscriberUserIds));
        setMembers(data.members);
        setEligible(data.eligible);
        setSaved(
          serialiseDigest(
            data.enabled,
            new Set(data.cadences),
            new Set(data.subscriberUserIds)
          )
        );
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [organizationId]);

  const toggleSubscriber = useCallback((userId: string, checked: boolean) => {
    setSubscribers((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(userId);
      } else {
        next.delete(userId);
      }
      return next;
    });
  }, []);

  const toggleCadence = useCallback((value: Cadence, checked: boolean) => {
    setCadences((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(value);
      } else {
        next.delete(value);
      }
      return next;
    });
  }, []);

  const dirty =
    saved !== null && serialiseDigest(enabled, cadences, subscribers) !== saved;

  const handleReset = useCallback(() => {
    if (!saved) {
      return;
    }
    const previous = JSON.parse(saved) as {
      enabled: boolean;
      cadences: Cadence[];
      subscribers: string[];
    };
    setEnabled(previous.enabled);
    setCadences(new Set(previous.cadences));
    setSubscribers(new Set(previous.subscribers));
  }, [saved]);

  const handleSave = useCallback(async () => {
    if (enabled && cadences.size === 0) {
      toast.error(DIGEST_REQUIRES_CADENCE_ERROR);
      return;
    }
    if (enabled && subscribers.size === 0) {
      toast.error(DIGEST_REQUIRES_SUBSCRIBER_ERROR);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        `/api/organizations/${organizationId}/execution-digest`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            cadences: [...cadences],
            subscriberUserIds: [...subscribers],
          }),
        }
      );
      if (res.ok) {
        setSaved(serialiseDigest(enabled, cadences, subscribers));
        toast.success("Digest settings saved");
      } else if (res.status === 402) {
        toast.error("Execution digests require a paid plan");
      } else {
        toast.error("Could not save settings");
      }
    } catch {
      toast.error("Could not save settings");
    } finally {
      setSaving(false);
    }
  }, [organizationId, enabled, cadences, subscribers]);

  const heading = (
    <h4 className="font-medium text-muted-foreground text-sm">
      Execution digest
    </h4>
  );

  if (!(loading || eligible)) {
    return (
      <div className="space-y-3">
        {heading}
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 p-4">
          <Gem className="size-4 shrink-0 text-accent-foreground" />
          <p className="flex-1 text-muted-foreground text-sm">
            Get a scheduled email summary of your workflow runs: total
            executions, successes, and failures. Available on paid plans.
          </p>
          {isBillingEnabled() &&
            (canManageBilling ? (
              <Button onClick={() => router.push("/settings")} size="sm">
                Upgrade
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button disabled size="sm">
                      Upgrade
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Only organization owners can upgrade the plan.
                </TooltipContent>
              </Tooltip>
            ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {heading}
      <div className="flex items-center justify-between gap-2">
        <Label className="cursor-pointer text-sm" htmlFor="digest-enabled">
          Email an execution summary on a schedule
        </Label>
        <Switch
          checked={enabled}
          disabled={loading || saving}
          id="digest-enabled"
          onCheckedChange={setEnabled}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-sm">Frequency</Label>
        <p className="text-muted-foreground text-xs">
          Pick one or more schedules; each sends its own digest.
        </p>
        <div className="space-y-2">
          {CADENCE_OPTIONS.map((opt) => (
            <div className="flex items-center gap-2" key={opt.value}>
              <Checkbox
                checked={cadences.has(opt.value)}
                disabled={!enabled || loading || saving}
                id={`digest-cadence-${opt.value}`}
                onCheckedChange={(checked) =>
                  toggleCadence(opt.value, checked === true)
                }
              />
              <Label
                className="cursor-pointer text-sm"
                htmlFor={`digest-cadence-${opt.value}`}
              >
                {opt.label}
              </Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>{opt.hint}</TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-sm">Subscribers</Label>
        <p className="text-muted-foreground text-xs">
          Choose which owners and admins receive the digest.
        </p>
        {members.length === 0 && !loading && (
          <p className="text-muted-foreground text-xs">
            No owners or admins to notify yet.
          </p>
        )}
        <div className="space-y-2">
          {members.map((m) => (
            <div className="flex items-center gap-2" key={m.userId}>
              <Checkbox
                checked={subscribers.has(m.userId)}
                disabled={!enabled || loading || saving}
                id={`digest-sub-${m.userId}`}
                onCheckedChange={(checked) =>
                  toggleSubscriber(m.userId, checked === true)
                }
              />
              <Label
                className="cursor-pointer text-sm"
                htmlFor={`digest-sub-${m.userId}`}
              >
                {m.email ?? m.name ?? m.userId}
                <span className="ml-1 text-muted-foreground text-xs">
                  ({m.role})
                </span>
              </Label>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        {dirty && !saving && (
          <span className="mr-auto text-muted-foreground text-xs">
            Unsaved changes
          </span>
        )}
        <Button
          disabled={!dirty || saving}
          onClick={handleReset}
          size="sm"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          disabled={loading || saving || !dirty}
          onClick={handleSave}
          size="sm"
        >
          {saving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
