"use client";

import { createContext, useContext, useMemo } from "react";
import { EMPTY_POLICY_CATALOG, type PolicyCatalog } from "@/lib/policy/ui";
import { useCachedSection } from "../hooks/use-cached-section";
import { useSettingsContext } from "../settings-context";

type PolicyCatalogState = {
  catalog: PolicyCatalog;
  loading: boolean;
};

const PolicyCatalogContext = createContext<PolicyCatalogState | null>(null);

/**
 * The catalog every policy control reads from.
 *
 * Held once, in context, rather than threaded through each picker. Passing it
 * down by hand meant a component three levels deep needed a prop it did not
 * use, purely to hand it on, and adding a list to the catalog touched every
 * component in the path.
 */
export function PolicyCatalogProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const { organizationId } = useSettingsContext();

  const section = useCachedSection<PolicyCatalog>(
    organizationId ? `policy-catalog:${organizationId}` : null,
    async () => {
      const res = await fetch(
        `/api/organizations/${organizationId}/policies/catalog`
      );
      if (!res.ok) {
        // A member rather than an admin. An empty catalog reads correctly.
        return EMPTY_POLICY_CATALOG;
      }
      return (await res.json()) as PolicyCatalog;
    }
  );

  const value = useMemo(
    () => ({
      catalog: section.data ?? EMPTY_POLICY_CATALOG,
      loading: section.loading,
    }),
    [section.data, section.loading]
  );

  return (
    <PolicyCatalogContext.Provider value={value}>
      {children}
    </PolicyCatalogContext.Provider>
  );
}

/** The catalog, from anywhere inside the policies section. */
export function usePolicyCatalog(): PolicyCatalogState {
  const value = useContext(PolicyCatalogContext);
  if (!value) {
    throw new Error(
      "usePolicyCatalog must be used inside a PolicyCatalogProvider"
    );
  }
  return value;
}
