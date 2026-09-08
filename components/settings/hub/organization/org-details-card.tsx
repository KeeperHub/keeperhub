"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { roleLabel } from "@/lib/organization/role-label";
import { useRenameDraft } from "../hooks/use-rename-draft";
import { SettingsCard } from "../section";

export function OrgDetailsCard({
  name,
  slug,
  role,
  canRename,
  onRename,
}: {
  name: string;
  slug: string;
  role: string | undefined;
  canRename: boolean;
  onRename: (next: string) => Promise<boolean>;
}): React.ReactElement {
  const draft = useRenameDraft(name, onRename);

  return (
    <SettingsCard
      description="Applies to the organization you are working in. Use the switcher in the header to work in another one."
      title="Organization details"
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="org-name">Name</Label>
            <Input
              disabled={!(canRename && draft.editing)}
              id="org-name"
              onChange={(e) => draft.set(e.target.value)}
              value={draft.editing ? (draft.value ?? "") : name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-slug">Slug</Label>
            <Input disabled id="org-slug" readOnly value={slug} />
            <p className="text-muted-foreground text-xs">
              Fixed once the organization is created.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <span className="flex items-center gap-2 text-muted-foreground text-sm">
            Your role
            <span className="rounded-full border px-2 py-0.5 text-[0.6875rem] text-foreground">
              {roleLabel(role) ?? "--"}
            </span>
          </span>
          {canRename && (
            <div className="flex gap-2">
              {draft.editing ? (
                <>
                  <Button onClick={draft.cancel} size="sm" variant="ghost">
                    Cancel
                  </Button>
                  <Button
                    disabled={draft.saving}
                    onClick={draft.commit}
                    size="sm"
                  >
                    {draft.saving ? "Saving..." : "Save name"}
                  </Button>
                </>
              ) : (
                <Button onClick={draft.start} size="sm" variant="outline">
                  Rename
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </SettingsCard>
  );
}
