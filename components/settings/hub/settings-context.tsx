"use client";

import { useParams, useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  reportLinkProblem,
  runOrgSwitch,
  useOrgSwitching,
} from "@/components/organization/org-switch-runner";
import {
  useActiveMember,
  useOrganization,
  useOrganizations,
} from "@/lib/hooks/use-organization";
import type { OrgRole } from "@/lib/organization/role-label";

type SettingsContextValue = {
  organizationId: string | null;
  organizationName: string | null;
  role: OrgRole | undefined;
  /** True until the active membership role has actually resolved. */
  roleLoading: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  isLoading: boolean;
  /**
   * Bumps on every active-organization change and on refreshAll(). Every
   * settings hook keys its fetch on it, so switching orgs reloads all of the
   * hub at once instead of each section discovering the change on its own.
   */
  revision: number;
  refreshAll: () => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const params = useParams();
  const {
    organization,
    isLoading: orgLoading,
    switchOrganization: setActiveOrganization,
  } = useOrganization();
  const { role: memberRole, isLoading: memberLoading } = useActiveMember();
  const {
    organizations,
    isLoading: orgsLoading,
    hasError: listFailed,
    reload: reloadList,
  } = useOrganizations();
  const router = useRouter();
  const [revision, setRevision] = useState(0);

  // The URL is the source of truth for org-scoped sections, so a shared link
  // opens the organization it was written for rather than whichever one the
  // session happens to be on.
  const routeOrgId = typeof params.orgId === "string" ? params.orgId : null;
  const organizationId = routeOrgId ?? organization?.id ?? null;

  const activeOrgId = organization?.id;
  const switching = useOrgSwitching();

  // Only a change of organization in the URL should drive a switch, never a
  // change of the active organization. Switching from the toolbar sets the
  // active org first and rewrites the path after, so reacting to the active
  // org would see the old path still in place and switch straight back.
  const reconciledRef = useRef<string | null>(null);

  // The URL's org the list failed for, so that is said once (its Try again
  // says it again should the list fail again).
  const listProblemFor = useRef<string | null>(null);

  // Through the switch runner, as the switchers' own: one switch at a time
  // (this waits for one running), and a failure says so with Try again. It
  // waits for the list too, which names the org. A link for an org the user
  // is not in (an old bookmark) says so and goes to Settings, where a switch
  // cannot work; a list that failed to load says that instead, with Try
  // again, and the switch waits for it.
  useEffect(() => {
    if (
      !(routeOrgId && activeOrgId) ||
      switching ||
      orgsLoading ||
      reconciledRef.current === routeOrgId
    ) {
      return;
    }
    if (routeOrgId === activeOrgId) {
      reconciledRef.current = routeOrgId;
      return;
    }
    if (listFailed) {
      if (listProblemFor.current !== routeOrgId) {
        listProblemFor.current = routeOrgId;
        reportLinkProblem("listFailed", reloadList);
      }
      return;
    }
    reconciledRef.current = routeOrgId;
    const routeOrg = organizations.find((org) => org.id === routeOrgId);
    if (!routeOrg) {
      reportLinkProblem("notMember");
      router.replace("/settings");
      return;
    }
    runOrgSwitch({
      orgId: routeOrg.id,
      name: routeOrg.name,
      start: () => setActiveOrganization(routeOrg.id),
      announce: false,
    }).then((ran) => {
      // Did not run (a switch took the lock first): tried again once that
      // one is done.
      if (ran === null && reconciledRef.current === routeOrgId) {
        reconciledRef.current = null;
      }
    });
  }, [
    routeOrgId,
    activeOrgId,
    switching,
    organizations,
    orgsLoading,
    listFailed,
    reloadList,
    router,
    setActiveOrganization,
  ]);

  // The role has to describe the organization on screen, which is the one in
  // the URL and not always the active one. /api/organizations carries a role
  // per organization, so it answers for whichever is being shown; the active
  // membership stands in until that list arrives, for the active org only
  // (never for another org a link names, which the user may not be in).
  const listedRole = organizations.find((o) => o.id === organizationId)?.role;
  const role = (listedRole ??
    (organizationId === organization?.id ? memberRole : undefined)) as
    | OrgRole
    | undefined;
  const roleLoading = !role && (memberLoading || orgsLoading || orgLoading);
  // Unknown is treated as no privileges, so a page never appears and then
  // disappears once the answer arrives.
  const isOwner = role === "owner";
  const isAdmin = role === "owner" || role === "admin";

  // biome-ignore lint/correctness/useExhaustiveDependencies: organizationId is a reload trigger, not a value this reads
  useEffect(() => {
    setRevision((n) => n + 1);
  }, [organizationId]);

  const refreshAll = useCallback((): void => {
    setRevision((n) => n + 1);
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      isAdmin,
      isLoading: orgLoading || memberLoading,
      isOwner,
      organizationId,
      organizationName: organization?.name ?? null,
      refreshAll,
      revision,
      role,
      roleLoading,
    }),
    [
      isAdmin,
      isOwner,
      memberLoading,
      roleLoading,
      organization?.name,
      organizationId,
      orgLoading,
      refreshAll,
      revision,
      role,
    ]
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettingsContext(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) {
    throw new Error("useSettingsContext must be used inside SettingsProvider");
  }
  return value;
}
