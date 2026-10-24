"use client";

import { SettingsMenu } from "@/components/settings/hub/settings-menu";
import { FormSkeleton } from "@/components/settings/hub/skeletons";

/**
 * The settings index. On a phone it is the settings menu, the rail at full
 * width; a wider window has the rail beside every section, so the menu sends
 * it on to the first section once the page has loaded. Until then a wide
 * window shows a section's skeleton rather than an empty column.
 */
export default function SettingsIndex(): React.ReactElement {
  return (
    <>
      <SettingsMenu />
      <div className="hidden md:block" data-testid="settings-index-loading">
        <FormSkeleton rows={3} />
      </div>
    </>
  );
}
