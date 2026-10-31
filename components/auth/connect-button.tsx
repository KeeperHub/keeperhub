"use client";

import { AuthDialog } from "@/components/auth/dialog";
import { Button } from "@/components/ui/button";

/**
 * In-app "Connect" entry point. Opens the shared AuthDialog, the same
 * single-column sign-in interface as the welcome page (email + social, plus a
 * wallet reveal).
 */
export function ConnectButton(): React.ReactElement {
  return (
    <AuthDialog>
      <Button className="h-9" size="sm" variant="default">
        Sign in
      </Button>
    </AuthDialog>
  );
}
