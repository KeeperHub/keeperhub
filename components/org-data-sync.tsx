"use client";

import { useSetAtom } from "jotai";
import { useEffect } from "react";
import {
  activeOrgScopeAtom,
  organizationsRefreshAtom,
  orgDataReadyAtom,
} from "@/lib/atoms/organization";
import { authClient } from "@/lib/auth-client";
import { registerOrganizationRefetch } from "@/lib/refetch-organizations";

/**
 * Drives the shared organization data in `lib/atoms/organization.ts`.
 *
 * Mounted once, inside the jotai provider, so the refetch registry gets a
 * single subscriber. Registering from the hooks instead would give one
 * subscriber per consuming component, and a refresh would fire as many
 * requests as there are consumers, which is what the store exists to stop.
 */
export function OrgDataSync(): null {
  const { data: activeOrg } = authClient.useActiveOrganization();
  const setReady = useSetAtom(orgDataReadyAtom);
  const setScope = useSetAtom(activeOrgScopeAtom);
  const setOrganizationsRefresh = useSetAtom(organizationsRefreshAtom);
  const activeOrgId = activeOrg?.id ?? null;

  // Fetching starts here rather than at module load, so a server render never
  // begins a request into a store it is about to throw away.
  useEffect(() => {
    setReady(true);
  }, [setReady]);

  useEffect(() => {
    setScope(activeOrgId);
  }, [activeOrgId, setScope]);

  useEffect(
    () =>
      registerOrganizationRefetch(() => {
        setOrganizationsRefresh((value) => value + 1);
      }),
    [setOrganizationsRefresh]
  );

  return null;
}
