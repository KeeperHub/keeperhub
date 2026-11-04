"use client";

import { type ComponentProps, useEffect } from "react";
import { cn } from "@/lib/utils";

/** The banner slot's height token; pages offset by it via --app-banner-height. */
const APP_BANNER_HEIGHT = "var(--app-banner-slot-height)";

/** Sets --app-banner-height while a banner shows, so fixed chrome moves down. */
export function useAppBannerOffset(visible: boolean): void {
  useEffect(() => {
    if (!visible) {
      return;
    }
    document.documentElement.style.setProperty(
      "--app-banner-height",
      APP_BANNER_HEIGHT
    );
    return (): void => {
      document.documentElement.style.removeProperty("--app-banner-height");
    };
  }, [visible]);
}

/** The fixed strip at the top of the app that every top banner renders in. */
export function AppBannerSlot({
  className,
  style,
  ...props
}: ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "pointer-events-auto fixed top-0 right-0 left-0 flex items-center justify-center border-b text-sm backdrop-blur-sm",
        className
      )}
      style={{
        height: APP_BANNER_HEIGHT,
        zIndex: "var(--z-banner)",
        ...style,
      }}
      {...props}
    />
  );
}
