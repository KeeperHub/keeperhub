"use client";

import { Check, ChevronsUpDown, Plus, Settings, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ManageOrgsModal } from "@/keeperhub/components/organization/manage-orgs-modal";
import {
  useOrganization,
  useOrganizations,
} from "@/keeperhub/lib/hooks/use-organization";
import { useSession } from "@/lib/auth-client";

export function OrgSwitcher() {
  const { data: session } = useSession();
  const {
    organization,
    switchOrganization,
    isLoading: orgLoading,
  } = useOrganization();
  const { organizations, isLoading: orgsLoading } = useOrganizations();
  const [open, setOpen] = useState(false);
  const [manageModalOpen, setManageModalOpen] = useState(false);
  const [autoSwitching, setAutoSwitching] = useState(false);

  // Auto-switch to first available org if no active org but user has orgs
  useEffect(() => {
    if (
      !(organization || orgsLoading || orgLoading) &&
      organizations.length > 0 &&
      !autoSwitching
    ) {
      setAutoSwitching(true);
      switchOrganization(organizations[0].id).finally(() => {
        setAutoSwitching(false);
      });
    }
  }, [
    organization,
    organizations,
    orgsLoading,
    orgLoading,
    switchOrganization,
    autoSwitching,
  ]);

  // Don't show anything if user is not logged in or is anonymous
  // Anonymous users have name "Anonymous" and temp- prefixed emails
  const isAnonymous =
    !session?.user ||
    session.user.name === "Anonymous" ||
    session.user.email?.startsWith("temp-");

  if (isAnonymous) {
    return null;
  }

  // Show loading state while auto-switching
  if (autoSwitching) {
    return (
      <Button
        className="w-[200px]"
        data-state="switching"
        disabled
        size="sm"
        variant="outline"
      >
        <Users className="mr-2 h-4 w-4" />
        Switching...
      </Button>
    );
  }

  // Handle edge case: user has no active organization AND no organizations at all
  if (!organization && organizations.length === 0 && !orgsLoading) {
    return (
      <>
        <Button
          onClick={() => setManageModalOpen(true)}
          size="sm"
          variant="outline"
        >
          <Plus className="mr-2 h-4 w-4" />
          Create Organization
        </Button>
        <ManageOrgsModal
          defaultShowCreateForm
          onOpenChange={setManageModalOpen}
          open={manageModalOpen}
        />
      </>
    );
  }

  // Still loading or waiting for auto-switch
  if (!organization) {
    return (
      <Button
        className="w-[200px]"
        data-state="loading"
        disabled
        size="sm"
        variant="outline"
      >
        <Users className="mr-2 h-4 w-4" />
        Loading...
      </Button>
    );
  }

  return (
    <>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            aria-label="Switch organization"
            className="w-[200px] justify-between"
            data-state="ready"
            data-testid="org-switcher"
            role="combobox"
            variant="outline"
          >
            <div className="flex items-center gap-2">
              <Users className="size-4 shrink-0" />
              <span className="truncate">{organization.name}</span>
            </div>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[200px] p-0">
          <Command>
            <CommandList>
              <CommandGroup>
                {organizations.map((org) => (
                  <CommandItem
                    key={org.id}
                    onSelect={() => {
                      setOpen(false);
                      switchOrganization(org.id);
                    }}
                  >
                    <Check
                      className={`mr-1 h-4 w-4 ${
                        organization.id === org.id ? "opacity-100" : "opacity-0"
                      }`}
                    />
                    {org.name}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  onSelect={() => {
                    setOpen(false);
                    setManageModalOpen(true);
                  }}
                >
                  <Settings className="mr-2 h-4 w-4" />
                  Manage Organizations
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <ManageOrgsModal
        onOpenChange={setManageModalOpen}
        open={manageModalOpen}
      />
    </>
  );
}
