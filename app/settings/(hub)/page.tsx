"use client";

import { SettingsMenu } from "@/components/settings/hub/settings-menu";

/**
 * The settings index. On a phone it is the settings menu, the rail at full
 * width; a wider window has the rail beside every section, so the menu sends
 * it on to the first section.
 */
export default function SettingsIndex(): React.ReactElement {
  return <SettingsMenu />;
}
