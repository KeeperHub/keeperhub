"use client";

import { SettingsMenu } from "@/components/settings/hub/settings-menu";

/**
 * Settings has no landing page of its own on a wide screen: the rail is the
 * index, and its search finds an individual setting, so the menu sends it on
 * to the first section. A phone has no rail, so there it is the menu.
 */
export default function SettingsIndex(): React.ReactElement | null {
  return <SettingsMenu />;
}
