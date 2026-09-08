"use client";

import { Check, ChevronsUpDown, Plus, Settings, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ManageOrgsModal } from "@/components/organization/manage-orgs-modal";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { useSession } from "@/lib/auth-client";
import {
  useOrganization,
  useOrganizations,
} from "@/lib/hooks/use-organization";
import { cn } from "@/lib/utils";

export function OrgSwitcher() {
  const router = useRouter();
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

  // NAV-05: hide entirely when signed out (session === null) or anonymous.
  // isAnonymousUser semantics already include null/undefined → true via the
  // `!session?.user` branch below, but we keep the explicit `session === null`
  // check first so the requirement ID is grep-able and the intent is obvious
  // to future readers.
  if (session === null) {
    return null;
  }
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
                  className="group"
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
                  {/* Clears the settings icon, which sits between the end of
                      the name and the edge of the row. */}
                  <TruncatedTooltip
                    className="min-w-0 flex-1 text-left"
                    side="right"
                    sideOffset={36}
                    text={org.name}
                  />
                  <div
                    className={cn(
                      // bg-border is the same colour as the row's hover fill, so it would
                      // disappear under the pointer.
                      "h-4 w-px shrink-0 bg-muted-foreground/60 transition group-hover:opacity-100",
                      org.id === organization.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {/* Selecting the row switches to the org; this opens its
                      settings without switching, so it must not bubble. */}
                  <Tooltip>
                    {/* Opening the list moves focus to the first thing that
                        takes it, which is this button. Radix opens a tooltip
                        on focus as well as on hover, so the name appeared
                        over a row nobody had pointed at. */}
                    <TooltipTrigger
                      asChild
                      onFocus={(event) => event.preventDefault()}
                    >
                      <button
                        aria-label={`Settings for ${org.name}`}
                        className={cn(
                          "shrink-0 rounded p-0.5 text-muted-foreground transition hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
                          org.id === organization.id
                            ? "opacity-100"
                            : "opacity-0"
                        )}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpen(false);
                          router.push(`/settings/${org.id}/organization`);
                        }}
                        type="button"
                      >
                        <Settings className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      Organization settings
                    </TooltipContent>
                  </Tooltip>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
