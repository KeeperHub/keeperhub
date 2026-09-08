"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export const WELCOME_STEPS = [
  { path: "/welcome/create-org", label: "Organization" },
  { path: "/welcome/invite-members", label: "Invite team" },
  { path: "/welcome/pay-per-execution", label: "Funding" },
  { path: "/welcome/connect-agent", label: "Connect agent" },
] as const;

export const WELCOME_STEP_COUNT = WELCOME_STEPS.length;

type WelcomeShellProps = {
  stepIndex: number;
  title: string;
  description: string;
  children: ReactNode;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  busy?: boolean;
  onBack?: () => void;
  onSkip?: () => void;
  skipLabel?: string;
  contentClassName?: string;
  // A stylized preview of the feature this step configures, rendered on the
  // right panel on a translucent gradient.
  preview?: ReactNode;
};

/**
 * Two-column layout shared by every onboarding wizard step: form on the left
 * with a step indicator and Back / Skip / Next controls, a static product
 * preview on the right. Mirrors Safe's create-space flow.
 */
export function WelcomeShell({
  stepIndex,
  title,
  description,
  children,
  onNext,
  nextLabel = "Next",
  nextDisabled,
  busy,
  onBack,
  onSkip,
  skipLabel = "Skip",
  contentClassName,
  preview,
}: WelcomeShellProps): React.ReactElement {
  return (
    <div className="grid min-h-screen grid-cols-1 lg:h-screen lg:grid-cols-5">
      <div className="flex flex-col justify-between p-8 lg:col-span-2 lg:overflow-y-auto lg:p-12">
        <div className="flex flex-col gap-6">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Step {stepIndex + 1} / {WELCOME_STEP_COUNT}
          </p>
          <div className="flex flex-col gap-1">
            <h1 className="font-semibold text-2xl">{title}</h1>
            <p className="text-muted-foreground text-sm">{description}</p>
          </div>
          <div className={cn("max-w-md", contentClassName)}>{children}</div>
        </div>

        <div className="mt-8 flex items-center justify-between gap-3">
          <div>
            {onBack ? (
              <Button
                disabled={busy}
                onClick={onBack}
                type="button"
                variant="ghost"
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {onSkip ? (
              <button
                className="text-muted-foreground text-sm hover:text-foreground"
                disabled={busy}
                onClick={onSkip}
                type="button"
              >
                {skipLabel}
              </button>
            ) : null}
            <Button
              disabled={nextDisabled || busy}
              onClick={onNext}
              type="button"
            >
              {busy ? <Spinner className="size-4" /> : nextLabel}
              {busy ? null : <ArrowRight className="size-4" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Feature preview stage: each preview positions itself within this
          relative, clipped area (OrgPreview bleeds off the right and fades
          right-to-left via its own mask; the modal previews center). The panel
          is darkened a touch so the lighter mock stands out. */}
      <div className="relative hidden select-none overflow-hidden border-border border-l bg-background lg:col-span-3 lg:block">
        <div className="pointer-events-none absolute inset-0 bg-black/25" />
        {preview}
      </div>
    </div>
  );
}
