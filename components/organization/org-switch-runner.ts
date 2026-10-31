import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { currentActiveOrgId } from "@/lib/hooks/use-organization";

export type OfferedOrg = {
  id: string;
  name: string;
  // What the switch it is offered again for would have done once made (a
  // link opening its settings).
  onSwitched?: () => void;
};

// The switch state the switchers and the other switches share, in one
// place. The active org itself is never copied here: it is read from the
// auth client (currentActiveOrgId), so it is right with no switcher mounted.
const state = {
  // Who is switching the active organization: the org switchers and the
  // links that open an org (one switch at a time; another pick or Try again
  // is ignored), or other code holding the switchers still while it
  // switches (leaving, deleting or creating one). A leave, delete or create
  // can start while a switch runs; the switchers then wait for both.
  holders: 0,
  // No organization is active and a switch to this one failed (the first
  // open, the open after leaving or deleting one, or a link's switch): both
  // switchers offer it again rather than opening one themselves. Null once
  // one is active.
  offeredOrg: null as OfferedOrg | null,
  // The org a running switch asked for from a control that goes away (a
  // toast's Try again, the switcher's state button) is opening: focus goes
  // to the switcher once it shows that org. Set before the switch starts,
  // as the org can show before the switch is done (on a workflow page it
  // then finds the workflow to open); cleared when the switch fails.
  focusAfterOrgId: null as string | null,
  // The active org is being loaded again after it could not be.
  reloadingOrg: false,
  // A load the user asked for found no org active (it is gone): the org the
  // switchers then open is announced, as nothing else answers the load.
  announceNextOpen: false,
  // The header's switcher offers to try again (to open an org, or load the
  // active one): where it is otherwise hidden, it shows.
  switcherOffering: false,
  // The toast the last switch left; the next switch clears it.
  lastSwitchToast: undefined as string | number | undefined,
  // The org the server switched to that the page could not show (its
  // refreshes failed): until the page shows it, the active org the auth
  // client holds is the old one, and is not taken as active.
  pageBehindFor: null as string | null,
  // The org the page showed then (undefined: none). Any other showing ends
  // it: the page caught up, or moved on to another org (after leaving one,
  // or a switch in another tab).
  pageBehindFrom: undefined as string | undefined,
  // What that switch would have done once made (a link opening its
  // settings): run once the page shows its org, so it never acts on the old
  // one. Dropped when another switch starts.
  afterPageShows: null as (() => void) | null,
};

// Said when the server switched but the page could not show the new org.
const PAGE_BEHIND_MESSAGE =
  "Switched organization, but couldn't update the page.";
// For a load of the active org asked for from the switcher: whichever org
// shows takes the focus request.
const ANY_ORG = "*";
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSwitching(): boolean {
  return state.holders > 0;
}

function getOfferedOrg(): OfferedOrg | null {
  return state.offeredOrg;
}

function getReloadingOrg(): boolean {
  return state.reloadingOrg;
}

function getSwitcherOffering(): boolean {
  return state.switcherOffering;
}

/** The header's switcher's note of whether it offers to try again. */
export function noteSwitcherOffering(offering: boolean): void {
  if (state.switcherOffering !== offering) {
    state.switcherOffering = offering;
    notify();
  }
}

/**
 * Whether the header's switcher offers to try again. Read without the org
 * hooks, which fetch, so a header shown signed out can read it.
 */
export function useSwitcherOffering(): boolean {
  return useSyncExternalStore(
    subscribe,
    getSwitcherOffering,
    getSwitcherOffering
  );
}

function hold(): void {
  state.holders += 1;
  notify();
}

function release(): void {
  state.holders -= 1;
  notify();
}

/** Whether the active organization is being switched. */
export function useOrgSwitching(): boolean {
  return useSyncExternalStore(subscribe, getSwitching, getSwitching);
}

/** Whether the active org is being loaded again after it could not be. */
export function useOrgReloading(): boolean {
  return useSyncExternalStore(subscribe, getReloadingOrg, getReloadingOrg);
}

/** The org to offer when none is active because opening one failed. */
export function useOfferedOrg(): OfferedOrg | null {
  return useSyncExternalStore(subscribe, getOfferedOrg, getOfferedOrg);
}

function setOfferedOrg(org: OfferedOrg | null): void {
  state.offeredOrg = org;
  notify();
}

/** The switchers' note that an org shows; one being active ends an offer. */
export function noteActiveOrg(orgId: string | null): void {
  if (orgId !== null) {
    state.announceNextOpen = false;
  }
  if (
    orgId !== null &&
    state.pageBehindFor !== null &&
    orgId !== state.pageBehindFrom
  ) {
    // The page has caught up, or moved on: what the switch was for is done
    // only where it shows that switch's org.
    const after = orgId === state.pageBehindFor ? state.afterPageShows : null;
    state.pageBehindFor = null;
    state.afterPageShows = null;
    notify();
    after?.();
  }
  if (orgId !== null && state.offeredOrg !== null) {
    setOfferedOrg(null);
  }
}

/**
 * Whether the org the switchers open on their own (none being active) is
 * to be announced: once, after a load the user asked for found none.
 */
export function takeOpenAnnouncement(): boolean {
  const announce = state.announceNextOpen;
  state.announceNextOpen = false;
  return announce;
}

// Said when a load the user asked for finds no org active and none to open.
const NO_ORG_MESSAGE = "You're no longer in any organization.";

/**
 * For a switcher that settles with none active and opens none itself (no
 * orgs, or one offered again): an announcement a load left is spent, never
 * kept for a later open the user did not ask for. With no orgs, that is
 * said, as nothing else answers the load.
 */
export function settleOpenAnnouncement(noOrgs: boolean): void {
  if (!state.announceNextOpen) {
    return;
  }
  state.announceNextOpen = false;
  if (noOrgs) {
    if (state.lastSwitchToast !== undefined) {
      toast.dismiss(state.lastSwitchToast);
    }
    state.lastSwitchToast = toast.info(NO_ORG_MESSAGE, { duration: 12_000 });
  }
}

/**
 * Whether focus should go to the switcher now that it shows `orgId`. Any
 * other org showing ends the request, so it never moves focus later.
 */
export function takeSwitcherFocus(orgId: string): boolean {
  const asked =
    state.focusAfterOrgId === orgId || state.focusAfterOrgId === ANY_ORG;
  state.focusAfterOrgId = null;
  return asked;
}

/**
 * Holds the switchers still while other code switches organization, so
 * no switcher switches meanwhile.
 */
export async function holdOrgSwitching<T>(work: () => Promise<T>): Promise<T> {
  hold();
  try {
    return await work();
  } finally {
    release();
  }
}

// What the toasts say, for switching to another org or opening one when none
// is active.
const WORDING = {
  switch: {
    loading: (name: string) => `Switching to ${name}...`,
    success: (name: string) => `Switched to ${name}`,
    failure: (name: string) => `Couldn't switch to ${name}.`,
  },
  open: {
    loading: (name: string) => `Opening ${name}...`,
    success: (name: string) => `Opened ${name}`,
    failure: (name: string) => `Couldn't open ${name}.`,
  },
};

type SwitchRequest = {
  orgId: string;
  name: string;
  start: () => Promise<boolean>;
  // Toasts for progress and success too, where nothing names the org.
  announce: boolean;
  kind?: keyof typeof WORDING;
  // Started from a control that goes away: focus the switcher after.
  refocus?: boolean;
  // Runs once this switch is made, by its first try or its Try again (a
  // link opens what it was for then).
  onSwitched?: () => void;
};

// Says a switch failed, replacing the last switch's toast, with Try again:
// a retry the user starts is announced, and puts focus back on the switcher.
function showFailure(
  message: string,
  request: SwitchRequest,
  id?: string | number
): void {
  if (id === undefined && state.lastSwitchToast !== undefined) {
    toast.dismiss(state.lastSwitchToast);
  }
  // Long enough to reach its Try again with a screen reader.
  state.lastSwitchToast = toast.error(message, {
    id,
    duration: 12_000,
    action: {
      label: "Try again",
      onClick: () => {
        // A retry the user asked for says how it went at every width:
        // nothing else answers the click.
        runOrgSwitch({ ...request, announce: true, refocus: true });
      },
    },
  });
}

/**
 * Runs a switch, unless one is running or the org is already active, and
 * says how it went: a failure always, with Try again, and where nothing on
 * screen names the org (`announce`) its progress and success too. Resolves
 * to whether it switched, or null when it did not run.
 */
export function runOrgSwitch(request: SwitchRequest): Promise<boolean | null> {
  const { orgId, name, start, announce, kind = "switch", refocus } = request;
  // Not for an org already active (one the server took though its answer
  // was lost, or one opened another way meanwhile); while the page is
  // behind, the org it shows is not the server's, so a pick of it runs.
  if (
    state.holders > 0 ||
    (orgId === currentActiveOrgId() && state.pageBehindFor === null)
  ) {
    return Promise.resolve(null);
  }
  hold();
  state.afterPageShows = null;
  if (state.lastSwitchToast !== undefined) {
    toast.dismiss(state.lastSwitchToast);
    state.lastSwitchToast = undefined;
  }
  const say = WORDING[kind];
  const id = announce ? toast.loading(say.loading(name)) : undefined;
  if (refocus) {
    state.focusAfterOrgId = orgId;
  }
  // Through a promise, so a start that throws still lets the lock go.
  return Promise.resolve()
    .then(start)
    .catch((error: unknown) => {
      console.error("[OrgSwitcher] Switch failed", error);
      return false;
    })
    .then((switched) => {
      if (switched) {
        if (state.offeredOrg !== null) {
          setOfferedOrg(null);
        }
        // Made on the server; whether the page shows it is another matter.
        const shown = currentActiveOrgId() === orgId;
        state.pageBehindFor = shown ? null : orgId;
        release();
        if (shown) {
          if (id !== undefined) {
            state.lastSwitchToast = toast.success(say.success(name), { id });
          }
          request.onSwitched?.();
        } else {
          reportPageBehind(orgId, { id });
          state.afterPageShows = request.onSwitched ?? null;
        }
        return true;
      }
      if (state.focusAfterOrgId === orgId) {
        state.focusAfterOrgId = null;
      }
      // Before the switchers are let go, so none opens an org itself: an
      // open that failed, or any switch with no org active (a link's), is
      // offered again, with what it would have done once made.
      if (kind === "open" || currentActiveOrgId() === undefined) {
        setOfferedOrg({ id: orgId, name, onSwitched: request.onSwitched });
      }
      release();
      showFailure(say.failure(name), { ...request, kind }, id);
      return false;
    });
}

/**
 * For a switch the server made (`orgId`) that the page could not show: says
 * so (`message`, by default that it switched), in place of the switch's own
 * toast (`id`) or the last one, with a Reload the user chooses. Until the
 * page shows it, the org it does show is not taken as active. Also for a
 * switch made outside the switchers (after leaving or deleting an org).
 */
export function reportPageBehind(
  orgId: string,
  {
    id,
    message = PAGE_BEHIND_MESSAGE,
  }: { id?: string | number; message?: string } = {}
): void {
  state.pageBehindFor = orgId;
  state.pageBehindFrom = currentActiveOrgId();
  state.afterPageShows = null;
  if (id === undefined && state.lastSwitchToast !== undefined) {
    toast.dismiss(state.lastSwitchToast);
  }
  state.lastSwitchToast = toast.error(message, {
    id,
    duration: 12_000,
    action: { label: "Reload", onClick: () => window.location.reload() },
  });
  notify();
}

function getPageBehind(): boolean {
  return state.pageBehindFor !== null;
}

/** Whether the page shows an org other than the one the server is in. */
export function usePageBehind(): boolean {
  return useSyncExternalStore(subscribe, getPageBehind, getPageBehind);
}

/**
 * For a switch made outside the switchers (after leaving or deleting the
 * active org) that could not open `org`: the switchers offer it, and the
 * failure is said as the switchers' own are, with Try again. Call while
 * holding the switchers.
 */
export function reportOpenFailure(
  org: OfferedOrg,
  message: string,
  start: () => Promise<boolean>
): void {
  setOfferedOrg(org);
  showFailure(message, {
    orgId: org.id,
    name: org.name,
    start,
    announce: true,
    kind: "open",
  });
}

// How loading the active org and the list again went.
export type OrgLoad = { org: boolean; list: boolean };

/**
 * Loads the active org and the list again after either could not be loaded
 * (`load` resolves to which now could), under the lock and always said: its
 * progress, then that both loaded, or a failure with Try again (the list's
 * own, reloading only it with `reloadList`, where only the list failed).
 * With `refocus`, focus goes to the switcher once an org shows.
 */
export function runOrgLoad(
  load: () => Promise<OrgLoad>,
  refocus: boolean,
  reloadList: () => Promise<boolean>
): Promise<boolean | null> {
  if (state.holders > 0) {
    return Promise.resolve(null);
  }
  state.reloadingOrg = true;
  hold();
  if (state.lastSwitchToast !== undefined) {
    toast.dismiss(state.lastSwitchToast);
    state.lastSwitchToast = undefined;
  }
  const id = toast.loading("Loading your organization...");
  if (refocus) {
    state.focusAfterOrgId = ANY_ORG;
  }
  return Promise.resolve()
    .then(load)
    .catch((error: unknown): OrgLoad => {
      console.error("[OrgSwitcher] Load failed", error);
      return { org: false, list: false };
    })
    .then(({ org, list }) => {
      state.reloadingOrg = false;
      // None active after all (it is gone): the switchers open one,
      // announced in place of this, and the focus request stands for it, as
      // the button that had focus is gone. Noted before they are let go.
      const noneActive = org && list && currentActiveOrgId() === undefined;
      if (noneActive) {
        state.announceNextOpen = true;
      }
      release();
      if (org && list) {
        if (noneActive) {
          toast.dismiss(id);
        } else {
          state.lastSwitchToast = toast.success("Loaded your organization", {
            id,
          });
        }
        return true;
      }
      if (org) {
        // The active org loaded (and shows, if there is one); only the list
        // did not: said as a link's is, with a Try again that loads it.
        toast.dismiss(id);
        state.lastSwitchToast = undefined;
        reportLinkProblem("listFailed", reloadList);
        return false;
      }
      if (state.focusAfterOrgId === ANY_ORG) {
        state.focusAfterOrgId = null;
      }
      state.lastSwitchToast = toast.error("Couldn't load your organization.", {
        id,
        duration: 12_000,
        action: {
          label: "Try again",
          onClick: () => {
            // Not once an org shows (loaded some other way meanwhile).
            if (currentActiveOrgId() === undefined) {
              runOrgLoad(load, true, reloadList);
            }
          },
        },
      });
      return false;
    });
}

// What a link to an org (a settings page's, a digest email's) says when it
// cannot switch to it.
const LINK_PROBLEM = {
  notMember: "You're not a member of that organization.",
  listFailed: "Couldn't load your organizations.",
};

/**
 * For a link to an org that cannot be switched to: says why, in place of the
 * last switch's toast and as long as a failure. Where the list failed to
 * load, with Try again, which reloads it (`reload`, resolving to whether it
 * loaded) and says so: the link goes on once it has, and a list that fails
 * again is said again. Not where the user is not in the org.
 */
export function reportLinkProblem(
  problem: keyof typeof LINK_PROBLEM,
  reload?: () => Promise<boolean>
): void {
  if (state.lastSwitchToast !== undefined) {
    toast.dismiss(state.lastSwitchToast);
  }
  state.lastSwitchToast = toast.error(LINK_PROBLEM[problem], {
    duration: 12_000,
    action: reload
      ? {
          label: "Try again",
          onClick: () => {
            reloadForLink(reload);
          },
        }
      : undefined,
  });
}

function reloadForLink(reload: () => Promise<boolean>): void {
  if (state.lastSwitchToast !== undefined) {
    toast.dismiss(state.lastSwitchToast);
  }
  const id = toast.loading("Loading your organizations...");
  state.lastSwitchToast = id;
  reload()
    .catch(() => false)
    .then((loaded) => {
      if (loaded) {
        toast.dismiss(id);
        if (state.lastSwitchToast === id) {
          state.lastSwitchToast = undefined;
        }
        return;
      }
      reportLinkProblem("listFailed", reload);
    });
}

/**
 * Back to a fresh page load. For tests: they share this module, and loading a
 * fresh copy of it would also load a second React.
 */
export function resetOrgSwitchState(): void {
  state.holders = 0;
  state.offeredOrg = null;
  state.focusAfterOrgId = null;
  state.reloadingOrg = false;
  state.announceNextOpen = false;
  state.switcherOffering = false;
  state.lastSwitchToast = undefined;
  state.pageBehindFor = null;
  state.pageBehindFrom = undefined;
  state.afterPageShows = null;
  notify();
}
