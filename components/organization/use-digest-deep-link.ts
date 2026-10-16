import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  reportLinkProblem,
  runOrgSwitch,
  useOrgSwitching,
} from "@/components/organization/org-switch-runner";
import {
  useOrganization,
  useOrganizations,
} from "@/lib/hooks/use-organization";

const PARAM = "digestSettings";

function dropParam(): void {
  const url = new URL(window.location.href);
  if (url.searchParams.has(PARAM)) {
    url.searchParams.delete(PARAM);
    window.history.replaceState(null, "", url.toString());
  }
}

/**
 * A digest email's "manage emails" link (`?digestSettings=<orgId>`): makes
 * that org the active one, so the whole page (switcher, role, plan) is for
 * it, and calls `onReady` once it is, to open the settings there. It waits
 * for the active org and the list to load and for a switch already running,
 * and switches through the switch runner: a failure says so with Try again,
 * and a Try again that works still calls `onReady`. The param stays on the
 * URL until the link is done with, and the link is let go once its switch
 * has run, or once
 * the list failed to load (its Try again follows it again), so it never
 * opens the settings later on its own.
 */
function useDigestDeepLink({
  enabled,
  onReady,
}: {
  enabled: boolean;
  onReady: () => void;
}): void {
  const searchParams = useSearchParams();
  const {
    organization,
    isLoading: orgLoading,
    switchOrganization,
  } = useOrganization();
  const {
    organizations,
    isLoading: orgsLoading,
    hasError: listFailed,
    reload: reloadList,
  } = useOrganizations();
  const switching = useOrgSwitching();
  // The org the link is for, until its switch has run (or it is active).
  const [linkedOrgId, setLinkedOrgId] = useState<string | null>(null);
  // A switch is starting for the link: it is not started twice.
  const starting = useRef(false);
  // The link was read: until the param is gone, it is not read again.
  const consumed = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const orgId = enabled ? searchParams.get(PARAM) : null;
    if (!orgId) {
      consumed.current = false;
      return;
    }
    if (consumed.current) {
      return;
    }
    consumed.current = true;
    setLinkedOrgId(orgId);
  }, [enabled, searchParams]);

  useEffect(() => {
    if (
      !linkedOrgId ||
      orgLoading ||
      orgsLoading ||
      switching ||
      starting.current
    ) {
      return;
    }
    const done = (): void => {
      setLinkedOrgId(null);
      dropParam();
    };
    if (organization?.id === linkedOrgId) {
      done();
      onReadyRef.current();
      return;
    }
    if (listFailed) {
      // Not knowing the user's orgs is not their not being in this one: said,
      // with Try again, which follows the link again once the list loads.
      // Otherwise the link is let go, so a list loaded later some other way
      // never switches on its own.
      const orgId = linkedOrgId;
      done();
      reportLinkProblem("listFailed", async () => {
        const loaded = await reloadList();
        if (loaded) {
          setLinkedOrgId(orgId);
        }
        return loaded;
      });
      return;
    }
    const linked = organizations.find((org) => org.id === linkedOrgId);
    if (!linked) {
      done();
      reportLinkProblem("notMember");
      return;
    }
    starting.current = true;
    runOrgSwitch({
      orgId: linked.id,
      name: linked.name,
      start: () => switchOrganization(linked.id),
      // Asked for by following the link: say how it goes.
      announce: true,
      onSwitched: () => onReadyRef.current(),
    }).then((ran) => {
      starting.current = false;
      // Did not run (a switch took the lock first): tried again once it is
      // done. Otherwise the link is done with; a Try again carries it.
      if (ran !== null) {
        done();
      }
    });
  }, [
    linkedOrgId,
    organization?.id,
    organizations,
    orgLoading,
    orgsLoading,
    listFailed,
    reloadList,
    switching,
    switchOrganization,
  ]);
}

/**
 * The manage organizations dialog's side of the digest link: opens it on the
 * Notifications tab once the link's org is the active one.
 */
export function useDigestSettingsOpener({
  enabled,
  setOpen,
  setActiveTab,
}: {
  enabled: boolean;
  setOpen: (open: boolean) => void;
  setActiveTab: (tab: string) => void;
}): void {
  const onReady = useCallback((): void => {
    setActiveTab("notifications");
    setOpen(true);
  }, [setActiveTab, setOpen]);
  useDigestDeepLink({ enabled, onReady });
}
