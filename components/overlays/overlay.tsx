"use client";

import { cn } from "@/lib/utils";
import { OverlayFooter } from "./overlay-footer";
import { SmartOverlayHeader } from "./overlay-header";
import type { OverlayProps } from "./types";

type OverlayComponentProps = OverlayProps & {
  /** The overlay's unique ID (passed automatically by the container) */
  overlayId: string;
};

/**
 * Base Overlay component for creating new overlays.
 * Provides consistent structure with header, content area, and footer.
 *
 * @example
 * ```tsx
 * function SettingsOverlay({ overlayId }: { overlayId: string }) {
 *   const { pop } = useOverlay();
 *
 *   return (
 *     <Overlay
 *       overlayId={overlayId}
 *       title="Settings"
 *       description="Manage your preferences"
 *       actions={[
 *         { label: "Cancel", variant: "outline", onClick: pop },
 *         { label: "Save", onClick: handleSave },
 *       ]}
 *     >
 *       <SettingsContent />
 *     </Overlay>
 *   );
 * }
 * ```
 */
export function Overlay({
  overlayId,
  title,
  description,
  actions,
  children,
  className,
}: OverlayComponentProps) {
  return (
    <div className={cn("flex max-h-[85vh] flex-col", className)}>
      {/* Header with smart back button detection */}
      {(title || description) && (
        <SmartOverlayHeader
          description={description}
          overlayId={overlayId}
          title={title}
        />
      )}

      {/* Content area. `thin-scrollbar` (globals.css) renders a styled,
          permanently visible scrollbar so users can tell when content
          extends below the fold; `scrollbar-gutter: stable` (inside the
          utility) keeps the gutter reserved so toggling overflow doesn't
          shift content horizontally. */}
      {children && (
        <div className="thin-scrollbar flex-1 overflow-y-scroll p-6">
          {children}
        </div>
      )}

      {/* Footer with actions */}
      <OverlayFooter actions={actions} />
    </div>
  );
}
