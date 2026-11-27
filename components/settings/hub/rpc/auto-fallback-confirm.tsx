"use client";

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

/** Changes that leave a chain without a default endpoint for Auto steps. */
export const AutoFallbackChange = {
  UNSET_DEFAULT: "unset-default",
  DISABLE_DEFAULT: "disable-default",
} as const;
export type AutoFallbackChange =
  (typeof AutoFallbackChange)[keyof typeof AutoFallbackChange];

export type AutoFallbackPrompt = {
  change: AutoFallbackChange;
  configName: string;
  chainName: string;
  /** Whether the chain uses the organization's endpoints only. */
  ownRpcOnly: boolean;
};

const TITLE: Readonly<
  Record<AutoFallbackChange, (prompt: AutoFallbackPrompt) => string>
> = {
  [AutoFallbackChange.UNSET_DEFAULT]: (p) =>
    `Stop using ${p.configName} as the ${p.chainName} default?`,
  [AutoFallbackChange.DISABLE_DEFAULT]: (p) =>
    `Disable ${p.configName}, the ${p.chainName} default?`,
};

const CONFIRM_LABEL: Readonly<Record<AutoFallbackChange, string>> = {
  [AutoFallbackChange.UNSET_DEFAULT]: "Remove default",
  [AutoFallbackChange.DISABLE_DEFAULT]: "Disable",
};

/** What Auto steps on the chain do once it has no default endpoint. */
export function autoFallbackConsequence(
  prompt: Pick<AutoFallbackPrompt, "chainName" | "ownRpcOnly">
): string {
  if (prompt.ownRpcOnly) {
    return `${prompt.chainName} uses your endpoints only, so steps and triggers on it set to Auto will have no endpoint and will not run. If a workflow depends on them, the change is refused and the affected steps are listed.`;
  }
  return `${prompt.chainName} will have no default endpoint, so steps and triggers on it set to Auto will run on KeeperHub's endpoints instead. Make another endpoint the default to keep them on yours.`;
}

/** Confirms a change after which Auto steps on a chain lose their endpoint. */
export function AutoFallbackConfirm({
  prompt,
  onConfirm,
  onCancel,
}: {
  /** Open while set. */
  prompt: AutoFallbackPrompt | null;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <AlertDialog
      onOpenChange={(open) => !open && onCancel()}
      open={prompt !== null}
    >
      <AlertDialogContent>
        {prompt && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {TITLE[prompt.change](prompt)}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {autoFallbackConsequence(prompt)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onConfirm}>
                {CONFIRM_LABEL[prompt.change]}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
