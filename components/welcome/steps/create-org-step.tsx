"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrgPreview } from "@/components/welcome/previews";
import { WelcomeShell } from "@/components/welcome/welcome-shell";
import { useOrganization } from "@/lib/hooks/use-organization";

const NEXT_PATH = "/welcome/invite-members";

/** Wizard step 1: rename the organization auto-created at signup. */
export function CreateOrgStep(): React.ReactElement {
  const router = useRouter();
  const { organization, refetch } = useOrganization();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (organization?.name) {
      setName((current) => current || organization.name);
    }
  }, [organization?.name]);

  const save = async (): Promise<boolean> => {
    const trimmed = name.trim();
    if (!(trimmed && organization?.id)) {
      return false;
    }
    if (trimmed === organization.name) {
      return true;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/organizations/${organization.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(data.error ?? "Could not rename organization");
        return false;
      }
      await refetch();
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not rename organization"
      );
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleNext = async (): Promise<void> => {
    if (await save()) {
      router.push(NEXT_PATH);
    }
  };

  return (
    <WelcomeShell
      busy={saving}
      description="Give your workspace a name your team will recognize. You can change it anytime in settings."
      nextDisabled={!name.trim()}
      onNext={handleNext}
      onSkip={() => router.push(NEXT_PATH)}
      preview={<OrgPreview name={name} />}
      stepIndex={0}
      title="Name your organization"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="org-name">Organization name</Label>
        <Input
          id="org-name"
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Treasury Ops"
          value={name}
        />
      </div>
    </WelcomeShell>
  );
}
