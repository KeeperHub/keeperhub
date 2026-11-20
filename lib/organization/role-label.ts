export type OrgRole = "owner" | "admin" | "member" | "viewer";

export const VIEWER_ROLE = "viewer" satisfies OrgRole;

/** Roles an invitation can grant; ownership is never handed out by invite. */
export type InviteRole = Exclude<OrgRole, "owner">;

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
 * True when the role may create, change, delete or run anything in the org.
 * An unknown role (not loaded yet, or no membership) cannot.
 */
export function canEditOrg(role: string | null | undefined): boolean {
  return Boolean(role) && !isViewerRole(role);
}

/** Badge label where a viewer, or anyone without edit rights, only reads. */
export const READ_ONLY_LABEL = "Read only";

/** Tooltip for an action a viewer sees but cannot use. */
export const VIEWER_DISABLED_REASON =
  "View-only access: you cannot make changes in this organization";

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
