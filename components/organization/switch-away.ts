import { toast } from "sonner";
import {
  holdOrgSwitching,
  reportOpenFailure,
  reportPageBehind,
} from "@/components/organization/org-switch-runner";
import { currentActiveOrgId } from "@/lib/hooks/use-organization";
import { refetchOrganizations } from "@/lib/refetch-organizations";

type Org = { id: string; name: string };

/**
 * After an organization is left or deleted (`done` says which): if it was
 * the active one, opens another and says so, or, when that fails, says so
 * with Try again (the switchers offer that org too) and, with `goHome`,
 * leaves the pages of the one that is gone. The org switchers stay still
 * meanwhile. Used by the settings page and the manage organizations dialog.
 */
export async function switchAwayFrom({
  removed,
  wasActive,
  organizations,
  done,
  switchOrganization,
  firstFrom,
  goHome,
}: {
  removed: Org;
  wasActive: boolean;
  organizations: Org[];
  done: "Left" | "Deleted";
  switchOrganization: (orgId: string, fromPath?: string) => Promise<boolean>;
  // The page the first attempt switches from, for a caller leaving the one
  // shown; a retry switches from wherever the user is by then.
  firstFrom?: string;
  goHome?: () => void;
}): Promise<void> {
  const next = organizations.find((org) => org.id !== removed.id);
  if (!(wasActive && next)) {
    toast.success(`${done} ${removed.name}`);
    return;
  }
  const switched = await holdOrgSwitching(async () => {
    const opened = await switchOrganization(next.id, firstFrom).catch(
      (error: unknown) => {
        console.error("[switchAwayFrom] Switch failed", error);
        return false;
      }
    );
    // Before the switchers are let go, so none opens an org itself.
    if (!opened) {
      // Leaving left the session with no org, which the page has not heard
      // (deleting tells it): reloaded, it shows none, and the switchers
      // offer the next.
      if (done === "Left") {
        refetchOrganizations();
      }
      reportOpenFailure(
        next,
        `${done} ${removed.name}, but couldn't open ${next.name}.`,
        () => switchOrganization(next.id)
      );
    }
    return opened;
  });
  if (switched) {
    // Made on the server; the page may not have caught up with it.
    if (currentActiveOrgId() === next.id) {
      toast.success(`${done} ${removed.name}. Now in ${next.name}.`);
    } else {
      // Still says the leave or delete went through.
      reportPageBehind(next.id, {
        message: `${done} ${removed.name}. Now in ${next.name}, but couldn't update the page.`,
      });
    }
    return;
  }
  goHome?.();
}
