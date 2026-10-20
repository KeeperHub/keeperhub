"use client";

import {
  Check,
  ChevronsUpDown,
  Loader2,
  type LucideIcon,
  Plus,
  RotateCw,
  Settings,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ManageOrgsModal } from "@/components/organization/manage-orgs-modal";
import {
  noteActiveOrg,
  noteSwitcherOffering,
  type OfferedOrg,
  runOrgLoad,
  runOrgSwitch,
  settleOpenAnnouncement,
  takeOpenAnnouncement,
  takeSwitcherFocus,
  useOfferedOrg,
  useOrgReloading,
  useOrgSwitching,
  usePageBehind,
} from "@/components/organization/org-switch-runner";
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
import { BELOW_LG_QUERY, useMediaQuery } from "@/hooks/use-mobile";
import { useSession } from "@/lib/auth-client";
import {
  activeOrgLoadFailed,
  useOrganization,
  useOrganizations,
} from "@/lib/hooks/use-organization";
import { getInitials, getOrganizationLabel } from "@/lib/initials";
import { cn } from "@/lib/utils";

// Px the org list keeps clear of the screen's bottom edge (Radix wants a
// number), where Safari's toolbar can sit on a phone turned sideways.
const CLEAR_OF_SCREEN_BOTTOM = 16;

// The header switcher gives way below lg to a header that needs the room
// (its wrapper in the toolbar sets how far); from sm it is 200px wide.
const HEADER_SHRINK = "sm:shrink lg:shrink-0";
const HEADER_BOX = cn("sm:w-50", HEADER_SHRINK);

// The look in the header, where below sm only the icon or the initials fit,
// and in the phone menu, which has the room for the name.
const HEADER_LOOK = {
  // Below sm (a phone held upright) the initials and the arrows stand in
  // for the name. From sm: people icon, name and arrows (HEADER_BOX); when a
  // crowded header squeezes it under the org-name container size, the
  // initials come back in the name's place.
  trigger: cn(
    "justify-between gap-1 has-[>svg]:px-2 aria-busy:opacity-50 sm:gap-2 sm:has-[>svg]:px-3 sm:max-lg:@container",
    HEADER_BOX
  ),
  icon: "hidden size-4 shrink-0 sm:block sm:@max-org-name:hidden",
  initials: "font-semibold sm:hidden sm:@max-org-name:inline",
  name: "hidden truncate sm:inline sm:@max-org-name:hidden",
  chevron: "h-4 w-4 shrink-0 opacity-50 sm:ml-2 sm:@max-org-name:ml-0",
  list: "w-50 p-0",
};
const MENU_LOOK = {
  trigger: "h-11 w-full justify-between has-[>svg]:px-3 aria-busy:opacity-50",
  icon: "size-4 shrink-0",
  name: "truncate",
  chevron: "h-4 w-4 shrink-0 opacity-50",
  list: "w-(--radix-popover-trigger-width) p-0",
};

// What a state other than ready says: in the header, spoken only below sm.
function StateText({
  inMenu,
  spoken,
  shown,
}: {
  inMenu: boolean;
  spoken: string;
  shown: string;
}): React.ReactNode {
  if (inMenu) {
    return <span className="truncate">{shown}</span>;
  }
  return (
    <>
      <span className="sr-only sm:hidden">{spoken}</span>
      <span className="hidden truncate sm:inline">{shown}</span>
    </>
  );
}

/**
 * The switcher with no organization to show: creating one, loading,
 * switching, failed to open one, or failed to load the active one. While
 * busy it stays focusable (it may hold focus from a click), marked busy
 * rather than disabled. Below sm in the
 * header it is as wide as the initials button, so nothing shifts; `wide`
 * false fits the content instead.
 */
function StateButton({
  state,
  icon: Icon,
  shown,
  spoken,
  inMenu,
  busy = false,
  disabled = false,
  wide = true,
  onClick,
  title,
  label,
}: {
  state: "create" | "loading" | "switching" | "failed";
  icon: LucideIcon;
  shown: string;
  spoken: string;
  inMenu: boolean;
  busy?: boolean;
  disabled?: boolean;
  wide?: boolean;
  onClick?: () => void;
  title?: string;
  // Its name where it must say more than it shows (the same at every width).
  label?: string;
}): React.ReactNode {
  return (
    <Button
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      aria-label={label}
      className={cn(
        // Looks as a disabled button does, while it stays focusable.
        "aria-busy:opacity-50",
        inMenu
          ? "h-11 w-full justify-start"
          : cn(
              "overflow-hidden",
              wide ? cn("min-w-14", HEADER_BOX) : HEADER_SHRINK
            )
      )}
      data-state={state}
      disabled={disabled}
      onClick={busy ? undefined : onClick}
      title={title}
      variant="outline"
    >
      <Icon className="h-4 w-4 sm:mr-2" />
      <StateText inMenu={inMenu} shown={shown} spoken={spoken} />
    </Button>
  );
}

/**
 * Drawn in the phone menu instead of the header: the menu closes on `onPick`
 * once the switcher is used (with `true` when nothing opens elsewhere, so
 * focus returns to the menu's button).
 */
export type OrgSwitcherMenu = {
  disabled: boolean;
  onPick: (returnFocus?: boolean) => void;
};

export function OrgSwitcher({
  menu,
  focusFallback,
}: {
  menu?: OrgSwitcherMenu;
  // Where focus goes in place of this header switcher when it is hidden
  // (below xs): the phone menu's button.
  focusFallback?: React.RefObject<HTMLElement | null>;
} = {}): React.ReactNode {
  const router = useRouter();
  const { data: session } = useSession();
  const {
    organization,
    switchOrganization,
    isLoading: orgLoading,
    loadFailed,
    refetch: refetchOrg,
  } = useOrganization();
  const reloading = useOrgReloading();
  const pageBehind = usePageBehind();
  const {
    organizations,
    isLoading: orgsLoading,
    hasError: listFailed,
    reload: reloadList,
  } = useOrganizations();
  const [open, setOpen] = useState(false);
  // Below lg, where the switcher can show initials instead of the name.
  const narrow = useMediaQuery(BELOW_LG_QUERY);
  const [manageModalOpen, setManageModalOpen] = useState(false);
  // Once each time no org is active: a switch that keeps failing would
  // otherwise be retried as fast as it fails. A failure offers to try again.
  const autoSwitchTried = useRef(false);
  // An org was active in this mount: once none is, the list is loaded
  // afresh before one is opened.
  const listStaleAfterLoss = useRef(false);
  const busy = useOrgSwitching();
  const offered = useOfferedOrg();
  const inMenu = menu !== undefined;
  const look = inMenu ? MENU_LOOK : HEADER_LOOK;
  // The menu closes on a pick, and below lg the header can show only
  // initials (which two orgs can share): there a switch is announced. A
  // failure is said at every width.
  const announced = inMenu || narrow;

  // Opens an org when none is active: quietly when it is automatic (the
  // first), announced when asked for.
  const openOrg = useCallback(
    (org: OfferedOrg, asked: boolean): void => {
      runOrgSwitch({
        orgId: org.id,
        name: org.name,
        start: () => switchOrganization(org.id),
        // A user who asked hears how it went at every width; the first,
        // automatic one is quiet.
        announce: asked,
        kind: "open",
        refocus: asked && !inMenu,
        onSwitched: org.onSwitched,
      });
    },
    [switchOrganization, inMenu]
  );

  // Either request failed: an empty list that failed to load is not having
  // none, and must not invite making a second.
  const couldNotLoad = loadFailed || listFailed || reloading;
  // Offering to try again, the header's switcher shows where it is otherwise
  // hidden (a 768-1023px window with a mouse).
  const offering = !organization && (couldNotLoad || offered !== null);
  useEffect(() => {
    if (inMenu) {
      return;
    }
    noteSwitcherOffering(offering);
    return () => noteSwitcherOffering(false);
  }, [inMenu, offering]);

  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    noteActiveOrg(organization?.id ?? null);
    // A switch asked for from a control that has gone (a toast's Try again,
    // the state button) puts focus back here once it shows that org, or on
    // the menu button where this header switcher is hidden (below xs); not
    // where neither shows (a window with a mouse at 768-1023px), and only
    // when focus went with that control, not where the user has moved it.
    if (organization?.id && !inMenu && takeSwitcherFocus(organization.id)) {
      // Once the header has caught up with the org shown: in a 768-1023px
      // window with a mouse this switcher shows only while it offers an
      // org, so it hides now, and focus must not go to it.
      const timer = setTimeout(() => {
        const lost =
          document.activeElement === null ||
          document.activeElement === document.body;
        const target = [triggerRef.current, focusFallback?.current].find(
          (element) => element && element.getClientRects().length > 0
        );
        if (lost) {
          target?.focus();
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [organization?.id, inMenu, focusFallback]);

  // Auto-switch to first available org if no active org but user has orgs.
  // The header's switcher is always mounted (if hidden), so it alone does,
  // and not while another switch runs (leaving or deleting one switches to
  // another itself) or after one has failed (it offers to open one instead).
  useEffect(() => {
    // An org is active: should none be again (removed by an admin, say),
    // this tries again, from a list loaded afresh, as the one it has may
    // still hold the org that just went.
    if (organization) {
      autoSwitchTried.current = false;
      listStaleAfterLoss.current = true;
    }
    const waiting =
      inMenu ||
      organization ||
      orgsLoading ||
      orgLoading ||
      // Not knowing the active org (or the list) is not having none:
      // opening the first here could take the user from the one they are in.
      loadFailed ||
      listFailed ||
      reloading ||
      busy ||
      // The server is in the org a switch made, which the page has not shown
      // yet: opening another would take the user from it.
      pageBehind;
    if (
      !(waiting || offered || autoSwitchTried.current) &&
      organizations.length > 0
    ) {
      if (listStaleAfterLoss.current) {
        listStaleAfterLoss.current = false;
        reloadList();
        return;
      }
      autoSwitchTried.current = true;
      // Quiet, unless it answers a load the user asked for.
      openOrg(organizations[0], takeOpenAnnouncement());
    } else if (!waiting) {
      // Settled with none active and none opened here.
      settleOpenAnnouncement(organizations.length === 0);
    }
  }, [
    organization,
    organizations,
    orgsLoading,
    orgLoading,
    loadFailed,
    listFailed,
    reloading,
    pageBehind,
    busy,
    offered,
    inMenu,
    openOrg,
    reloadList,
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

  if (
    !organization &&
    organizations.length === 0 &&
    !orgsLoading &&
    !couldNotLoad
  ) {
    // No organization yet: create one.
    return (
      <>
        <StateButton
          disabled={menu?.disabled}
          icon={Plus}
          inMenu={inMenu}
          onClick={() => setManageModalOpen(true)}
          shown="Create Organization"
          spoken="Create Organization"
          state="create"
          wide={false}
        />
        <ManageOrgsModal
          defaultShowCreateForm
          onOpenChange={setManageModalOpen}
          open={manageModalOpen}
        />
      </>
    );
  }

  if (!organization && couldNotLoad) {
    // The active org or the list could not be loaded (no answer, or the
    // server's own error): offer to load them again, said as a switch is.
    // Named with what it shows first, so voice control finds it by that.
    const loadName = "Load organization, try again";
    return (
      <StateButton
        // Also while another switch runs, when a click would do nothing.
        busy={reloading || busy}
        disabled={menu?.disabled}
        icon={RotateCw}
        inMenu={inMenu}
        label={loadName}
        onClick={() => {
          // The menu closes, so its result toast can be reached.
          menu?.onPick(true);
          runOrgLoad(
            async () => {
              // Once both have arrived: which loaded.
              const [, list] = await Promise.all([refetchOrg(), reloadList()]);
              return { org: !activeOrgLoadFailed(), list };
            },
            !inMenu,
            reloadList
          );
        }}
        shown="Load organization"
        spoken={loadName}
        state="failed"
        title={loadName}
      />
    );
  }

  if (!organization && busy) {
    return (
      <StateButton
        busy
        icon={Users}
        inMenu={inMenu}
        shown="Switching..."
        spoken="Switching organization"
        state="switching"
      />
    );
  }

  if (!organization && offered) {
    // Opening an org failed: offer it again (never one just left), with a
    // retry mark, the org where there is room ("Open X"; only the mark in a
    // phone's header), and the same name everywhere, which says so.
    const retryName = `Try again: open ${offered.name}`;
    return (
      <StateButton
        disabled={menu?.disabled}
        icon={RotateCw}
        inMenu={inMenu}
        label={retryName}
        onClick={() => {
          // The menu closes, so its result toast can be reached.
          menu?.onPick(true);
          openOrg(offered, true);
        }}
        shown={`Open ${offered.name}`}
        spoken={retryName}
        state="failed"
        title={retryName}
      />
    );
  }

  if (!organization) {
    return (
      <StateButton
        disabled
        icon={Users}
        inMenu={inMenu}
        shown="Loading..."
        spoken="Loading organization"
        state="loading"
      />
    );
  }

  const initials = getInitials(organization.name);

  return (
    // Modal in the menu, whose own scroll lock would otherwise stop a long
    // list from scrolling.
    // While a switch runs the list stays shut (the trigger keeps focus, so
    // it is not disabled).
    <Popover
      modal={inMenu}
      onOpenChange={(next) => setOpen(next && !busy)}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          aria-busy={busy || undefined}
          aria-disabled={busy || undefined}
          aria-expanded={open}
          // Below lg it leads with what it shows (the name, or the initials),
          // so voice control finds it by either; a combobox takes its name
          // from the label, not its content. From lg: "Switch organization".
          aria-label={
            narrow
              ? `${getOrganizationLabel(organization.name)}, switch organization`
              : "Switch organization"
          }
          className={look.trigger}
          data-state="ready"
          data-testid={inMenu ? "mobile-nav-org-switcher" : "org-switcher"}
          disabled={menu?.disabled}
          ref={triggerRef}
          role="combobox"
          variant="outline"
        >
          <div className="flex items-center gap-2 max-lg:min-w-0">
            <Users className={look.icon} />
            {inMenu ? null : (
              <span className={HEADER_LOOK.initials} data-org-initials>
                {initials}
              </span>
            )}
            <span className={look.name} data-org-name>
              {organization.name}
            </span>
          </div>
          {busy ? (
            <Loader2
              className={cn(
                look.chevron,
                "animate-spin opacity-100 motion-reduce:animate-none"
              )}
            />
          ) : (
            <ChevronsUpDown className={look.chevron} />
          )}
        </Button>
      </PopoverTrigger>
      {/* Clear of the bottom edge, where Safari's toolbar can sit on a
          phone turned sideways. Below lg never taller than the screen below
          the switcher: the list, under its own cap, shrinks to fit and
          scrolls, so the last organization stays reachable. */}
      <PopoverContent
        align="start"
        className={cn(
          look.list,
          "max-lg:flex max-lg:max-h-(--radix-popover-content-available-height) max-lg:flex-col"
        )}
        collisionPadding={{ bottom: CLEAR_OF_SCREEN_BOTTOM }}
      >
        <Command className="max-lg:min-h-0">
          <CommandList className="max-lg:min-h-0">
            <CommandGroup>
              {organizations.map((org) => (
                <CommandItem
                  // A 44px row in the phone header's list (phone-ui).
                  className="group phone-ui:min-h-11"
                  key={org.id}
                  onSelect={() => {
                    setOpen(false);
                    // Focus goes back to the menu's button: the header
                    // stays, and the page is the same one (or its
                    // counterpart) in the new org.
                    menu?.onPick(true);
                    // The org in use is not switched to again: that would
                    // only clear the workflow editor and open another one.
                    // Unless the page is behind the server: then the org
                    // it shows is not the one in use, and the pick runs.
                    if (org.id === organization.id && !pageBehind) {
                      return;
                    }
                    runOrgSwitch({
                      orgId: org.id,
                      name: org.name,
                      start: () => switchOrganization(org.id),
                      announce: announced,
                    });
                  }}
                >
                  <Check
                    className={`mr-1 h-4 w-4 ${
                      organization.id === org.id ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  {/* Clears the settings icon, which sits between the end of
                      the name and the edge of the row. In the phone
                      header's list (phone-ui), with no hover for the
                      tooltip on a touch screen, a long name wraps instead
                      of being cut short. */}
                  <TruncatedTooltip
                    className="min-w-0 flex-1 text-left phone-ui:whitespace-normal phone-ui:break-words"
                    side="right"
                    sideOffset={36}
                    text={org.name}
                  />
                  <div
                    className={cn(
                      // bg-border is the same colour as the row's hover fill, so it would
                      // disappear under the pointer.
                      "h-4 w-px shrink-0 bg-muted-foreground/60 transition group-hover:opacity-100",
                      org.id === organization.id
                        ? "opacity-100"
                        : "opacity-0 touch-ui:hidden"
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
                          // A 26px target in the phone header's list.
                          "shrink-0 rounded p-0.5 text-muted-foreground transition hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 phone-ui:p-1.5",
                          org.id === organization.id
                            ? "opacity-100"
                            : // Never shown in the phone header's list or on
                              // a touch screen (shown only on hover),
                              // so it must not catch a tap meant for the row.
                              "opacity-0 touch-ui:hidden"
                        )}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpen(false);
                          menu?.onPick();
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
