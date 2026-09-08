"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  findSettingsItem,
  isSettingsItemVisible,
  type SettingsNavItem,
} from "./nav";
import { EmptyState, SectionHeader, SettingsCard } from "./section";
import { useSettingsContext } from "./settings-context";
import { FormSkeleton } from "./skeletons";

function accessMessage(item: SettingsNavItem): string {
  return item.ownerOnly
    ? "Only the owner of this organization can see this section."
    : "Only admins and owners of this organization can see this section.";
}

/**
 * The rail hides sections a role cannot use, but the routes behind them stay
 * reachable by URL, and switching organizations keeps the path while the role
 * changes underneath it. The gate answers for the organization in the path, so
 * a restricted section stays closed however it was reached.
 */
export function SettingsAccessGate({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const pathname = usePathname();
  const { isAdmin, isOwner, roleLoading } = useSettingsContext();
  const item = findSettingsItem(pathname);

  if (!(item?.ownerOnly || item?.adminOnly)) {
    return <>{children}</>;
  }
  // Rendering the section before the role lands would show it to everyone for
  // a frame, so hold the page until the answer is in.
  if (roleLoading) {
    return <FormSkeleton rows={3} />;
  }
  if (isSettingsItemVisible(item, { isAdmin, isOwner })) {
    return <>{children}</>;
  }

  return (
    <>
      <SectionHeader description={item.description} title={item.label} />
      <SettingsCard>
        <EmptyState>{accessMessage(item)}</EmptyState>
      </SettingsCard>
    </>
  );
}
