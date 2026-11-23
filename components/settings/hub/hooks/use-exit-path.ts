"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const STORAGE_KEY = "keeperhub-pre-settings-path";
const FALLBACK = "/workflows";

function isSettings(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/**
 * Remembers the last page outside settings. Mounted app-wide so the path is
 * already stored by the time settings opens.
 */
export function useRecordExitPath(): void {
  const pathname = usePathname();

  useEffect(() => {
    if (isSettings(pathname)) {
      return;
    }
    try {
      sessionStorage.setItem(STORAGE_KEY, pathname);
    } catch {
      // Storage is blocked (site data disabled, some private modes) and the
      // access throws. This hook runs on every route, so letting it escape
      // would take the whole page down; settings falls back to FALLBACK.
    }
  }, [pathname]);
}

/**
 * Where leaving settings should land. Browser history would walk back through
 * every section visited inside settings, so the way out is stored separately.
 */
export function useExitPath(): string {
  const [path, setPath] = useState(FALLBACK);

  // Read after mount: session storage does not exist while rendering on the
  // server, and guessing would flash the wrong destination.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage is blocked; keep FALLBACK.
    }
    if (stored && !isSettings(stored)) {
      setPath(stored);
    }
  }, []);

  return path;
}
