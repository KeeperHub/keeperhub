"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsCard } from "./section";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function CreateOrgForm({
  onCreate,
  onDone,
}: {
  onCreate: (name: string, slug: string) => Promise<boolean>;
  onDone: () => void;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    setSaving(true);
    const ok = await onCreate(name, slug);
    setSaving(false);
    if (ok) {
      onDone();
    }
  };

  return (
    <SettingsCard
      description="Organizations keep workflows, wallets, members and billing separate."
      title="New organization"
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="new-org-name">Name</Label>
            <Input
              id="new-org-name"
              onChange={(e) => {
                setName(e.target.value);
                if (!slugEdited) {
                  setSlug(slugify(e.target.value));
                }
              }}
              placeholder="Ridgeline Capital"
              value={name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-org-slug">Slug</Label>
            <Input
              id="new-org-slug"
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugEdited(true);
              }}
              placeholder="ridgeline-capital"
              value={slug}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onDone} variant="outline">
            Cancel
          </Button>
          <Button disabled={!(name && slug) || saving} onClick={submit}>
            {saving ? "Creating..." : "Create organization"}
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}
