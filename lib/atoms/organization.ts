import { atom } from "jotai";
import { api, type Project, type Tag } from "@/lib/api-client";

export type OrganizationWithRole = {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: string;
  metadata: string | null;
  role: string;
};

/**
 * Shared organization-scoped data.
 *
 * Every one of these used to be a `useState` + `useEffect` + `fetch` inside a
 * hook, so a page mounting five consumers made five identical requests. Here
 * the request belongs to the atom instead of to the component, and the five
 * consumers read one result.
 *
 * Nothing loads until `OrgDataSync` marks the app ready on the client. These
 * atoms live in the provider store from `app/layout.tsx`, which is created per
 * render, so a server render must never start a fetch into it.
 */
export const orgDataReadyAtom = atom(false);

/**
 * The organization the data below belongs to. Anything scoped to it takes this
 * as a dependency, so switching organizations refetches it and nothing else.
 */
export const activeOrgScopeAtom = atom<string | null>(null);

export const organizationsRefreshAtom = atom(0);
export const walletRefreshAtom = atom(0);
export const projectsRefreshAtom = atom(0);
export const tagsRefreshAtom = atom(0);

export const organizationsAtom = atom(
  async (get): Promise<OrganizationWithRole[] | null> => {
    if (!get(orgDataReadyAtom)) {
      return null;
    }
    get(organizationsRefreshAtom);
    // Which organizations a user belongs to, and their role in each, does not
    // depend on which one is currently active, so this survives a switch.
    const response = await fetch("/api/organizations");
    if (!response.ok) {
      throw new Error(`Failed to load organizations: ${response.status}`);
    }
    return (await response.json()) as OrganizationWithRole[];
  }
);

export type OrgWalletSummary = {
  hasWallet?: boolean;
  walletAddress?: string;
};

/**
 * The organization's wallet, shared by everything that only needs to know
 * whether one exists and at which address. Five components asked for this
 * separately before.
 */
export const walletAtom = atom(async (get): Promise<OrgWalletSummary | null> => {
  if (!(get(orgDataReadyAtom) && get(activeOrgScopeAtom))) {
    return null;
  }
  get(walletRefreshAtom);
  const response = await fetch("/api/user/wallet");
  if (!response.ok) {
    return { hasWallet: false };
  }
  return (await response.json()) as OrgWalletSummary;
});

export const projectsAtom = atom(async (get): Promise<Project[] | null> => {
  if (!(get(orgDataReadyAtom) && get(activeOrgScopeAtom))) {
    return null;
  }
  get(projectsRefreshAtom);
  return await api.project.getAll();
});

export const tagsAtom = atom(async (get): Promise<Tag[] | null> => {
  if (!(get(orgDataReadyAtom) && get(activeOrgScopeAtom))) {
    return null;
  }
  get(tagsRefreshAtom);
  return await api.tag.getAll();
});
