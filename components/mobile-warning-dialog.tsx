"use client";

import { Monitor } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "keeperhub-mobile-warning-dismissed";
const MOBILE_BREAKPOINT = 768;

export function MobileWarningDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let dismissed: string | null = null;
    try {
      dismissed = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Safari Private Browsing / Lockdown Mode blocks storage access and
      // throws SecurityError. Treat as not dismissed and show the warning.
    }
    if (!dismissed && window.innerWidth < MOBILE_BREAKPOINT) {
      setOpen(true);
    }
  }, []);

  if (!open) {
    return null;
  }

  const handleContinue = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      // Storage unavailable; dismiss for this session only.
    }
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        className="fixed inset-0 bg-black/50"
        onClick={handleContinue}
        type="button"
      />
      <div className="relative z-50 grid w-full max-w-[calc(100%-2rem)] gap-4 rounded-lg border bg-background p-6 shadow-lg sm:max-w-md">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
            <Monitor className="size-6 text-muted-foreground" />
          </div>
          <h2 className="font-semibold text-lg leading-none">
            Desktop Optimized
          </h2>
          <p className="text-muted-foreground text-sm">
            This app is optimized for desktop. For the best experience, please
            use a larger screen.
          </p>
        </div>
        <div className="flex justify-center">
          <Button className="w-full sm:w-auto" onClick={handleContinue}>
            Continue Anyway
          </Button>
        </div>
      </div>
    </div>
  );
}
