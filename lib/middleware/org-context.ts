import { headers } from "next/headers";
import { auth } from "@/lib/auth";

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/**
 * Extract activeOrganizationId from a better-auth session.
 * The organization plugin adds this field at runtime but the base
 * Session type doesn't include it after the 1.5.x upgrade.
 */
export function getActiveOrgId(session: AuthSession): string | undefined {
  return (
    (session.session as { activeOrganizationId?: string })
      .activeOrganizationId ?? undefined
  );
}

type User = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
};

type Organization = {
  id: string;
  name: string;
  slug?: string | null;
  logo?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
};

type Member = {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date;
};

export type OrgContext = {
  user: User | null;
  organization: Organization | null;
  member: Member | null;
  isAnonymous: boolean;
  needsOrganization: boolean;
};

export async function getOrgContext(): Promise<OrgContext> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return {
      user: null,
      organization: null,
      member: null,
      isAnonymous: true,
      needsOrganization: false,
    };
  }

  const activeOrgId = getActiveOrgId(session);

  if (!activeOrgId) {
    // Authenticated user without active organization
    // This should not happen as afterSignUp hook creates org automatically
    return {
      user: session.user,
      organization: null,
      member: null,
      isAnonymous: false,
      needsOrganization: true,
    };
  }

  // Get full organization details
  const orgData = await auth.api.getFullOrganization({
    headers: await headers(),
    query: { organizationId: activeOrgId },
  });

  const activeMember = await auth.api.getActiveMember({
    headers: await headers(),
  });

  // Extract organization data from response (getFullOrganization returns org data merged with members/invitations)
  const organizationData = orgData
    ? {
        id: orgData.id,
        name: orgData.name,
        slug: orgData.slug,
        logo: orgData.logo,
        metadata: orgData.metadata,
        createdAt: orgData.createdAt,
      }
    : null;

  return {
    user: session.user,
    organization: organizationData,
    member: activeMember || null,
    isAnonymous: false,
    needsOrganization: !orgData,
  };
}

// Permission helper
export async function hasPermission(
  resource: string,
  actions: string[]
): Promise<boolean> {
  const result = await auth.api.hasPermission({
    headers: await headers(),
    body: {
      permissions: {
        [resource]: actions,
      },
    },
  });

  return result?.success;
}
