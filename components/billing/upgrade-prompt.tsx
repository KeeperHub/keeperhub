"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type UpgradePromptProps = {
  message?: string;
};

export function UpgradePrompt({
  message = "You've reached your plan limit. Upgrade to continue.",
}: UpgradePromptProps): React.ReactElement {
  const router = useRouter();

  return (
    <div className="flex items-center gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-4 py-3">
      <p className="text-sm text-yellow-700 dark:text-yellow-200 flex-1">
        {message}
      </p>
      <Button
        className="shrink-0 border-yellow-500/50 text-yellow-700 dark:text-yellow-200 hover:bg-yellow-500/10"
        onClick={() => router.push("/billing")}
        size="sm"
        variant="outline"
      >
        Upgrade
      </Button>
    </div>
  );
}
