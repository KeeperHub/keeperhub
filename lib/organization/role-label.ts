export type OrgRole = "owner" | "admin" | "member" | "viewer";

export const VIEWER_ROLE = "viewer" satisfies OrgRole;

const ROLE_LABELS: Record<OrgRole, string> = {
  admin: "Admin",
  member: "Member",
  owner: "Owner",
  viewer: "Viewer",
};

function isOrgRole(value: string): value is OrgRole {
  return (
    value === "owner" ||
    value === "admin" ||
    value === "member" ||
    value === "viewer"
  );
}

/** Viewers can read everything in the org but cannot change anything. */
export function isViewerRole(role: string | null | undefined): boolean {
  return role?.toLowerCase() === VIEWER_ROLE;
}

/**
 * Display name for a membership role. Roles are stored lowercase; every
 * user-facing surface should read them through here so casing and wording
 * stay consistent, including for roles we do not have a label for yet.
 */
export function roleLabel(role: string | null | undefined): string | null {
  if (!role) {
    return null;
  }
  const normalized = role.toLowerCase();
  if (isOrgRole(normalized)) {
    return ROLE_LABELS[normalized];
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
