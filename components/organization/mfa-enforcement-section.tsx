"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { StepUpFactor } from "@/lib/mfa/step-up-policy";

type EnforcementState = {
  enforce: boolean;
  factors: StepUpFactor[];
};

const FACTOR_OPTIONS: {
  factor: Exclude<StepUpFactor, "wallet">;
  label: string;
  hint: string;
}[] = [
  {
    factor: "totp",
    label: "Authenticator app",
    hint: "A TOTP code from an app like 1Password or Google Authenticator.",
  },
  {
    factor: "email",
    label: "Verified email",
    hint: "A confirmation code sent to an inbox the member controls.",
  },
];

export function MfaEnforcementSection({
  organizationId,
  canEdit = true,
}: {
  organizationId: string;
  /** Admins see the status read-only; only the owner can change it. */
  canEdit?: boolean;
}): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enforce, setEnforce] = useState(false);
  const [factors, setFactors] = useState<Set<StepUpFactor>>(new Set());

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(
        `/api/organizations/${organizationId}/mfa-enforcement`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        toast.error("Couldn't load MFA enforcement settings.");
        setLoadError(true);
        return;
      }
      const data = (await res.json()) as EnforcementState;
      setEnforce(data.enforce);
      setFactors(new Set(data.factors ?? []));
    } catch {
      toast.error("Couldn't load MFA enforcement settings.");
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleFactor = (factor: StepUpFactor, checked: boolean): void => {
    setFactors((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(factor);
      } else {
        next.delete(factor);
      }
      return next;
    });
  };

  const save = async (): Promise<void> => {
    const selected = [...factors];
    if (enforce && selected.length === 0) {
      toast.error("Select at least one factor to enforce.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        `/api/organizations/${organizationId}/mfa-enforcement`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enforce, factors: selected }),
        }
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ?? "Couldn't save settings.");
        return;
      }
      toast.success("MFA enforcement updated.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="py-6 text-center text-muted-foreground text-sm">
        Failed to load MFA settings.{" "}
        <button className="underline" onClick={() => load()} type="button">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 rounded-md border bg-muted/30 p-3">
        <div className="space-y-1">
          <Label className="font-medium text-sm">
            Require two-factor for all members
          </Label>
          <p className="text-muted-foreground text-xs">
            Members must carry a second factor while this organization is their
            active context. Wallet members are prompted to enroll before they
            can continue.
          </p>
        </div>
        <Switch
          checked={enforce}
          data-testid="org-mfa-enforce-toggle"
          disabled={!canEdit}
          onCheckedChange={setEnforce}
        />
      </div>

      {enforce && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            Required factors (members must add every one selected):
          </p>
          {FACTOR_OPTIONS.map((option) => (
            <div
              className="flex items-start justify-between gap-4 rounded-md border p-3"
              key={option.factor}
            >
              <div className="space-y-0.5">
                <Label className="text-sm">{option.label}</Label>
                <p className="text-muted-foreground text-xs">{option.hint}</p>
              </div>
              <Switch
                checked={factors.has(option.factor)}
                data-testid={`org-mfa-factor-${option.factor}`}
                disabled={!canEdit}
                onCheckedChange={(checked) =>
                  toggleFactor(option.factor, checked)
                }
              />
            </div>
          ))}
        </div>
      )}

      {canEdit ? (
        <div className="flex justify-end">
          <Button
            data-testid="org-mfa-save"
            disabled={saving}
            onClick={save}
            size="sm"
          >
            {saving ? <Spinner className="size-4" /> : "Save"}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Only the organization owner can change this setting.
        </p>
      )}
    </div>
  );
}
