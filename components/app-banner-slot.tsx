"use client";

import { type ComponentProps, useEffect } from "react";
import { cn } from "@/lib/utils";

/** The banner slot's height token; pages offset by it via --app-banner-height. */
const APP_BANNER_HEIGHT = "var(--app-banner-slot-height)";

/**
 * Sets --app-banner-height to `rows` stacked banners while any show, so fixed
 * chrome moves down. One caller owns it at a time; 0 leaves it alone.
 */
export function useAppBannerOffset(rows: number): void {
  useEffect(() => {
    if (rows <= 0) {
      return;
    }
    document.documentElement.style.setProperty(
      "--app-banner-height",
      rows === 1 ? APP_BANNER_HEIGHT : `calc(${rows} * ${APP_BANNER_HEIGHT})`
    );
    return (): void => {
      document.documentElement.style.removeProperty("--app-banner-height");
    };
  }, [rows]);
}

/** The fixed strip at the top of the app that every top banner renders in. */
export function AppBannerSlot({
  className,
  style,
  row = 0,
  ...props
}: ComponentProps<"div"> & {
  /** Banners stack: 0 is the top strip, 1 the one under it. */
  row?: number;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "pointer-events-auto fixed top-0 right-0 left-0 flex items-center justify-center border-b text-sm backdrop-blur-sm",
        className
      )}
      style={{
        height: APP_BANNER_HEIGHT,
        top: row > 0 ? `calc(${row} * ${APP_BANNER_HEIGHT})` : 0,
        zIndex: "var(--z-banner)",
        ...style,
      }}
      {...props}
    />
  );
}
