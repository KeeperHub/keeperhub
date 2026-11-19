"use client";

import { useActiveMember } from "@/lib/hooks/use-organization";
import {
  canEditOrg,
  isViewerRole,
  type OrgRole,
} from "@/lib/organization/role-label";

export type OrgAccess = {
  role: OrgRole | undefined;
  isLoading: boolean;
  /** The caller is a viewer: read-only in the active org. */
  isViewer: boolean;
  /** The caller may create, change, delete or run things in the active org. */
  canEdit: boolean;
};

/**
 * The caller's access in the active organization. Every write action in the
 * UI (create, edit, delete, run, connect) is gated on `canEdit`, which is
 * false for viewers and while the role is still loading.
 */
export function useOrgAccess(): OrgAccess {
  const { role, isLoading } = useActiveMember();
  return {
    role,
    isLoading,
    isViewer: isViewerRole(role),
    canEdit: canEditOrg(role),
  };
}
