export type OrgRole = "owner" | "admin" | "member";

const ROLE_LABELS: Record<OrgRole, string> = {
  admin: "Admin",
  member: "Member",
  owner: "Owner",
};

function isOrgRole(value: string): value is OrgRole {
  return value === "owner" || value === "admin" || value === "member";
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
