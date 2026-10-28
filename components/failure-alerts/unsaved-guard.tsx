"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** An in-app link that would leave this page, or null. */
function leavingLink(event: MouseEvent): string | null {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return null;
  }
  const anchor = (event.target as Element | null)?.closest?.("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) {
    return null;
  }
  if (anchor.target === "_blank" || anchor.hasAttribute("download")) {
    return null;
  }
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) {
    return null;
  }
  if (url.pathname === window.location.pathname) {
    return null;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Asks before leaving with unsaved changes: the browser's own prompt for a
 * reload or close, and a dialog for links inside the app.
 */
export function UnsavedChangesGuard({
  dirty,
}: {
  dirty: boolean;
}): React.ReactElement {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    const onClick = (event: MouseEvent): void => {
      const href = leavingLink(event);
      if (!href) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setPending(href);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          setPending(null);
        }
      }}
      open={pending !== null}
    >
      <AlertDialogContent data-testid="failure-alerts-unsaved-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
          <AlertDialogDescription>
            Some alert settings on this page are not saved. They are lost if you
            leave now.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Stay</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const href = pending;
              setPending(null);
              if (href) {
                router.push(href);
              }
            }}
          >
            Leave
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
