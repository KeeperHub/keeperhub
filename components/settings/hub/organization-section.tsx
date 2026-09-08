"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useOrganizations } from "@/lib/hooks/use-organization";
import { CreateOrgForm } from "./create-org-form";
import { useOrgMembers } from "./hooks/use-org-members";
import { useOrganizationList } from "./hooks/use-organization-list";
import { LeaveOrgCard } from "./organization/leave-org-card";
import { OrgDetailsCard } from "./organization/org-details-card";
import { SectionHeader } from "./section";
import { useSettingsContext } from "./settings-context";

export function OrganizationSection(): React.ReactElement {
  const { organizationId, isOwner, role } = useSettingsContext();
  const { organizations } = useOrganizations();
  const { rename, create } = useOrganizationList();
  const { members } = useOrgMembers();
  const [creating, setCreating] = useState(false);

  const org = organizations.find((o) => o.id === organizationId);

  return (
    <>
      <SectionHeader
        action={
          <Button onClick={() => setCreating((v) => !v)} variant="outline">
            <Plus className="size-4" />
            New organization
          </Button>
        }
        description="This organization and the people in it. Everything here applies only to the organization selected in the header."
        title="Organization"
      />

      {creating && (
        <CreateOrgForm onCreate={create} onDone={() => setCreating(false)} />
      )}

      <OrgDetailsCard
        canRename={isOwner}
        name={org?.name ?? ""}
        onRename={(next) =>
          organizationId ? rename(organizationId, next) : Promise.resolve(false)
        }
        role={role}
        slug={org?.slug ?? ""}
      />

      <LeaveOrgCard
        isOwner={isOwner}
        members={members}
        organizationId={organizationId}
        organizationName={org?.name ?? ""}
      />
    </>
  );
}
