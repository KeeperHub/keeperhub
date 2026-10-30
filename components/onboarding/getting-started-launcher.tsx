"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, ChevronDown, Compass, Info, Sparkles, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiKeysOverlay } from "@/components/overlays/api-keys-overlay";
import { ConnectAgentOverlay } from "@/components/overlays/connect-agent-overlay";
import { IntegrationsOverlay } from "@/components/overlays/integrations-overlay";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { WalletOverlay } from "@/components/overlays/wallet-overlay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import {
  type GettingStarted,
  useGettingStarted,
} from "@/lib/hooks/use-getting-started";
import {
  type Chip,
  type DeepLinkTarget,
  getBranches,
  type Step,
} from "@/lib/onboarding/getting-started-config";
import { isPreAppPath } from "@/lib/pre-app-paths";
import { refetchSidebar } from "@/lib/refetch-sidebar";
import { cn } from "@/lib/utils";
import {
  editorTourRequestedAtom,
  gettingStartedDockedAtom,
  gettingStartedOpenAtom,
  pendingAiPromptAtom,
} from "@/lib/workflow/store";

// AI workflow generation is gated by this flag and is off in prod + staging.
const AI_ENABLED = process.env.NEXT_PUBLIC_AI_PROMPT_ENABLED === "true";

// 8px under the header plus the card's mb-2 above the pill, and the card's
// heading row with its borders: what the step list cannot use.
const CARD_GAP = 16;
const CARD_HEADING_HEIGHT = 50;

function ProgressRing({
  done,
  total,
}: {
  done: number;
  total: number;
}): React.ReactElement {
  const r = 8;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? done / total : 0;
  return (
    <svg aria-hidden="true" className="-rotate-90 size-5" viewBox="0 0 20 20">
      <circle
        className="text-muted-foreground/30"
        cx="10"
        cy="10"
        fill="none"
        r={r}
        stroke="currentColor"
        strokeWidth="2"
      />
      <circle
        className="text-keeperhub-green transition-[stroke-dashoffset] duration-500"
        cx="10"
        cy="10"
        fill="none"
        r={r}
        stroke="currentColor"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function StepCheck({ complete }: { complete: boolean }): React.ReactElement {
  return (
    <span
      className={cn(
        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
        complete
          ? "border-keeperhub-green bg-keeperhub-green text-white"
          : "border-muted-foreground/40"
      )}
    >
      {complete && <Check aria-hidden="true" className="size-3" />}
    </span>
  );
}

function StepRow({
  step,
  complete,
  locked,
  isChipCloned,
  onAction,
  onChip,
  onTour,
  onInfo,
}: {
  step: Step;
  complete: boolean;
  locked?: boolean;
  isChipCloned: (chip: Chip) => boolean;
  onAction: (step: Step) => void;
  onChip: (step: Step, chip: Chip) => void;
  onTour: (step: Step) => void;
  onInfo: (step: Step) => void;
}): React.ReactElement {
  const clickable = Boolean(step.action) && !step.muted && !locked;
  const body = (
    <div className="flex-1 space-y-1.5 text-left">
      <div
        className={cn(
          "font-medium text-sm",
          (step.muted || locked) && "text-muted-foreground"
        )}
      >
        {step.title}
      </div>
      <p className="text-muted-foreground text-xs">{step.description}</p>
    </div>
  );

  return (
    <div
      className={cn(
        "rounded-md transition-colors",
        locked ? "opacity-60" : "hover:bg-muted/40"
      )}
      data-complete={complete}
      data-testid={`gs-step-${step.key}`}
    >
      <div className="flex items-start gap-2 p-2">
        {clickable && step.action ? (
          <button
            className="flex flex-1 items-start gap-3"
            onClick={() => onAction(step)}
            type="button"
          >
            <StepCheck complete={complete} />
            {body}
          </button>
        ) : (
          <div className="flex flex-1 items-start gap-3">
            <StepCheck complete={complete} />
            {body}
          </div>
        )}
        <button
          aria-label={`More info about ${step.title}`}
          // A 44px target on touch screens.
          className="mt-0.5 flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground touch-ui:-m-2 touch-ui:size-11"
          onClick={() => onInfo(step)}
          title="More info"
          type="button"
        >
          <Info aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {step.chips && !locked && (
        <div className="flex flex-wrap gap-1.5 px-2 pb-2 pl-9">
          {step.chips.map((chip) => {
            const cloned = isChipCloned(chip);
            return (
              <button
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-1 text-xs transition-colors hover:bg-muted touch-ui:min-h-11",
                  cloned && "border-keeperhub-green text-keeperhub-green"
                )}
                key={chip.id}
                onClick={() => onChip(step, chip)}
                type="button"
              >
                {cloned && <Check aria-hidden="true" className="size-3" />}
                {chip.label}
                {chip.badge ? (
                  <span className="template-badge px-1">{chip.badge}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      {step.offerTour && !locked && (
        <div className="px-2 pb-2 pl-9">
          <button
            className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 font-medium text-primary text-xs transition-colors hover:bg-primary/20 touch-ui:min-h-11"
            onClick={() => onTour(step)}
            type="button"
          >
            <Compass aria-hidden="true" className="size-3.5" />
            Take a guided tour
          </button>
        </div>
      )}
    </div>
  );
}

function StepInfoDialog({
  step,
  creditLabel,
  onAction,
  onTour,
  onClose,
}: {
  step: Step | null;
  creditLabel: string;
  onAction: (step: Step) => void;
  onTour: (step: Step) => void;
  onClose: () => void;
}): React.ReactElement {
  const action = step?.action;
  const fill = (text: string): string =>
    text.replaceAll("{credit}", creditLabel);
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={step !== null}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{step?.title}</DialogTitle>
          <DialogDescription>
            {step ? fill(step.info.summary) : ""}
          </DialogDescription>
        </DialogHeader>
        {step ? (
          <div className="flex flex-col gap-4">
            {step.info.sections.map((section) => (
              <div className="flex flex-col gap-1.5" key={section.heading}>
                <p className="font-medium text-foreground text-sm">
                  {section.heading}
                </p>
                <ul className="flex flex-col gap-1.5">
                  {section.points.map((point) => (
                    <li
                      className="flex gap-2 text-muted-foreground text-sm"
                      key={point}
                    >
                      <span
                        aria-hidden="true"
                        className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/60"
                      />
                      <span>{fill(point)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
        {step && action && step.actionLabel ? (
          <DialogFooter className="sm:justify-between sm:gap-2">
            {step.offerTour ? (
              <Button
                onClick={() => {
                  onTour(step);
                  onClose();
                }}
                type="button"
                variant="outline"
              >
                Take a guided tour
              </Button>
            ) : null}
            <Button
              onClick={() => {
                onAction(step);
                onClose();
              }}
              type="button"
            >
              {step.actionLabel}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ExpandedCard({
  gs,
  creditLabel,
  listMaxHeight,
  onAction,
  onChip,
  onTour,
}: {
  gs: GettingStarted;
  creditLabel: string;
  listMaxHeight?: number;
  onAction: (step: Step) => void;
  onChip: (step: Step, chip: Chip) => void;
  onTour: (step: Step) => void;
}): React.ReactElement {
  const [infoStep, setInfoStep] = useState<Step | null>(null);
  const { steps, done, total } = checklistProgress(gs);

  return (
    // Grow in height (and scale in from the pill corner) on open; shrink height
    // and width back toward the pill on close. overflow-hidden clips the rows as
    // the height animates; the card's own shadow is not clipped by it.
    <motion.div
      animate={{ height: "auto", opacity: 1, scale: 1 }}
      className="w-80 overflow-hidden rounded-xl border bg-popover shadow-xl"
      data-testid="gs-launcher-card"
      exit={{ height: 0, opacity: 0, scale: 0.5 }}
      initial={{ height: 0, opacity: 0, scale: 0.5 }}
      style={{ transformOrigin: "bottom left" }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">Getting started</span>
          <span
            className="text-muted-foreground text-xs"
            data-done={done}
            data-testid="gs-progress"
            data-total={total}
          >
            {done} of {total}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            aria-label="Collapse"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => gs.setState("collapsed")}
            type="button"
          >
            <ChevronDown aria-hidden="true" className="size-4" />
          </button>
          <button
            aria-label="Dismiss"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => gs.setState("dismissed")}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>

      <div
        className="max-h-[60vh] space-y-1 overflow-y-auto px-2 py-2"
        style={
          listMaxHeight === undefined
            ? undefined
            : { maxHeight: `min(60vh, ${listMaxHeight}px)` }
        }
      >
        <StepList
          gs={gs}
          onAction={onAction}
          onChip={onChip}
          onInfo={setInfoStep}
          onTour={onTour}
          steps={steps}
        />
      </div>

      <StepInfoDialog
        creditLabel={creditLabel}
        onAction={onAction}
        onClose={() => setInfoStep(null)}
        onTour={onTour}
        step={infoStep}
      />
    </motion.div>
  );
}

// Single linear checklist: the agent branch (Wallet ready -> Connect your
// agent -> Run your first workflow). Monitor / Yield are no longer surfaced.
function checklistProgress(gs: GettingStarted): {
  steps: Step[];
  done: number;
  total: number;
} {
  const branches = getBranches(gs.chipContext);
  const steps = (branches.find((b) => b.key === "agent") ?? branches[0]).steps;
  const done = steps.filter((s) => gs.isStepComplete(s)).length;
  return { steps, done, total: steps.length };
}

function StepList({
  gs,
  steps,
  onAction,
  onChip,
  onTour,
  onInfo,
}: {
  gs: GettingStarted;
  steps: Step[];
  onAction: (step: Step) => void;
  onChip: (step: Step, chip: Chip) => void;
  onTour: (step: Step) => void;
  onInfo: (step: Step) => void;
}): React.ReactElement {
  return (
    <>
      {steps.map((step, idx) => {
        const locked = steps.slice(0, idx).some((s) => !gs.isStepComplete(s));
        return (
          <StepRow
            complete={gs.isStepComplete(step)}
            isChipCloned={(chip) =>
              gs.hasLiveStepWorkflow(`${step.key}:${chip.id}`)
            }
            key={step.key}
            locked={locked}
            onAction={onAction}
            onChip={onChip}
            onInfo={onInfo}
            onTour={onTour}
            step={step}
          />
        );
      })}
    </>
  );
}

// The env-driven free gas sponsorship amount, for the wallet info copy.
function useCreditLabel(): string {
  const [creditLabel, setCreditLabel] = useState("$1");
  useEffect(() => {
    let cancelled = false;
    fetch("/api/gas-sponsorship")
      .then((r) => r.json())
      .then((data: { label?: string }) => {
        if (!cancelled && data?.label) {
          setCreditLabel(data.label);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return creditLabel;
}

/**
 * What the checklist's steps, chips and tour buttons do. From the overlay a
 * step's surface stacks on it (Back returns to the checklist), and the
 * overlay closes before going to a workflow.
 */
function useStepActions(
  gs: GettingStarted,
  { inOverlay = false }: { inOverlay?: boolean } = {}
): {
  onAction: (step: Step) => void;
  onChip: (step: Step, chip: Chip) => void;
  onTour: (step: Step) => void;
} {
  const router = useRouter();
  const { open, push, closeAll } = useOverlay();
  const [, setPendingAiPrompt] = useAtom(pendingAiPromptAtom);
  const requestTour = useSetAtom(editorTourRequestedAtom);

  const openWorkflow = (id: string): void => {
    if (inOverlay) {
      closeAll();
    }
    router.push(`/workflows/${id}`);
  };

  const openDeepLink = (target: DeepLinkTarget): void => {
    const show = inOverlay ? push : open;
    if (target === "api-keys") {
      show(ApiKeysOverlay);
    } else if (target === "connect-agent") {
      show(ConnectAgentOverlay, undefined, { size: "2xl" });
    } else if (target === "integrations") {
      show(IntegrationsOverlay);
    } else {
      show(WalletOverlay);
    }
  };

  // AI generation is gated by NEXT_PUBLIC_AI_PROMPT_ENABLED and is OFF in prod +
  // staging. When enabled, seed the prompt so the builder auto-generates; when
  // not, just open a fresh builder with the prompt kept as the description so
  // the user still has the context of what they set out to build.
  //
  // The workflow is created once per (step, prompt) and remembered: taking the
  // step again reopens that same draft instead of spawning another Untitled
  // Workflow. If the user deleted it, a fresh one is created.
  // Open the step's draft workflow: reuse the one created for this persist key
  // if it still exists, otherwise create a fresh trigger+action draft.
  // Chip paths pass persistKey `${step.key}:${chip.id}` so clone and AI-fallback
  // share the same slot; non-chip AI actions still key by prompt text.
  // In tour mode it requests the guided editor tour instead of seeding the AI
  // prompt, so the tour runs on the same draft.
  const startStepWorkflow = async (
    step: Step,
    prompt: string,
    opts?: { tour?: boolean; persistKey?: string }
  ): Promise<void> => {
    const key = opts?.persistKey ?? `${step.key}:${prompt}`;
    let id = gs.getStepWorkflowId(key);
    if (id) {
      try {
        await api.workflow.getById(id);
      } catch {
        id = undefined;
      }
    }
    if (!id) {
      try {
        const stamp = Date.now();
        const triggerId = `trigger-${stamp}`;
        const actionId = `action-${stamp}`;
        const workflow = await api.workflow.create({
          name: "Untitled Workflow",
          description: prompt,
          nodes: [
            {
              id: triggerId,
              type: "trigger" as const,
              position: { x: 400, y: 200 },
              data: {
                label: "",
                type: "trigger" as const,
                config: { triggerType: "Manual" },
                status: "idle" as const,
              },
            },
            {
              id: actionId,
              type: "action" as const,
              position: { x: 672, y: 200 },
              data: {
                label: "",
                type: "action" as const,
                config: {},
                status: "idle" as const,
              },
            },
          ],
          edges: [
            {
              id: `edge-${stamp}`,
              source: triggerId,
              target: actionId,
              type: "animated",
            },
          ],
        });
        id = workflow.id;
        gs.setStepWorkflowId(key, id);
        // Surface the freshly created workflow in the sidebar list immediately.
        refetchSidebar({ workflowCreated: true });
      } catch {
        toast.error("Could not start a workflow.");
        return;
      }
    }
    if (opts?.tour) {
      requestTour(true);
    } else if (AI_ENABLED) {
      setPendingAiPrompt(prompt);
    }
    openWorkflow(id);
  };

  // Taking a step's action opens the relevant surface. Outcome steps only
  // complete once the real state changes (refetched here and on focus); the
  // informational "open your wallet" steps complete on open via markStepActioned.
  const onAction = (step: Step): void => {
    gs.markStepActioned(step);
    const { action } = step;
    if (action?.kind === "deeplink") {
      openDeepLink(action.target);
    } else if (action?.kind === "ai-prompt") {
      startStepWorkflow(step, action.prompt);
    }
    gs.refetch();
  };

  // Clone a curated public HUB workflow into the user's org, ONCE per chip.
  // If this chip was already cloned and that copy still exists, reopen it
  // instead of cloning again (otherwise every click spawns another copy). The
  // clone is the step's completion -- the user configures it after in the builder.
  const cloneStarterWorkflow = async (
    step: Step,
    chip: Chip
  ): Promise<void> => {
    if (!chip.workflowId) {
      return;
    }
    const key = `${step.key}:${chip.id}`;
    let id = gs.getStepWorkflowId(key);
    if (id) {
      try {
        await api.workflow.getById(id);
      } catch {
        // The earlier clone was deleted; fall through and re-clone.
        id = undefined;
      }
    }
    if (!id) {
      try {
        const workflow = await api.workflow.duplicate(chip.workflowId);
        id = workflow.id;
        gs.setStepWorkflowId(key, id);
        // The new clone won't appear in the sidebar list until it refetches.
        refetchSidebar({ workflowCreated: true });
      } catch (error) {
        console.error(
          `[GettingStarted] Failed to clone starter workflow ${chip.workflowId}`,
          error
        );
        toast.error(
          error instanceof Error
            ? error.message
            : "Could not add that workflow."
        );
        return;
      }
    }
    // The step/chip mark themselves complete by deriving from this live clone
    // (see hasLiveStepWorkflow / isStepComplete) -- no separate latch to clobber.
    openWorkflow(id);
  };

  // Chips with a configured starter workflow clone it; otherwise fall back to
  // seeding the AI builder with the chip's preset prompt.
  const onChip = (step: Step, chip: Chip): void => {
    gs.markStepActioned(step);
    if (chip.workflowId) {
      cloneStarterWorkflow(step, chip);
    } else {
      startStepWorkflow(step, chip.prompt, {
        persistKey: `${step.key}:${chip.id}`,
      });
    }
  };

  // "Take a guided tour": open the step's draft and launch the editor tour,
  // which walks the user through building and running the workflow.
  const onTour = (step: Step): void => {
    gs.markStepActioned(step);
    const prompt = step.action?.kind === "ai-prompt" ? step.action.prompt : "";
    startStepWorkflow(step, prompt, { tour: true });
  };

  return { onAction, onChip, onTour };
}

export function GettingStartedLauncher({
  compact = false,
}: {
  // Icon-only pill for a collapsed sidebar. The label + count show otherwise.
  compact?: boolean;
} = {}): React.ReactElement | null {
  const gs = useGettingStarted();
  const gsRef = useRef(gs);
  gsRef.current = gs;
  const pathname = usePathname();
  const [forceOpen, setForceOpen] = useAtom(gettingStartedOpenAtom);
  const setDocked = useSetAtom(gettingStartedDockedAtom);
  const creditLabel = useCreditLabel();
  const { onAction, onChip, onTour } = useStepActions(gs);
  const expanded = gs.state === "expanded";
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);
  const [listMaxHeight, setListMaxHeight] = useState<number>();

  // The card grows up from the pill: keep it below the header in short
  // windows, so its title and buttons stay on screen. Kept current while
  // collapsed too, so it opens at the right height.
  useEffect(() => {
    const sidebar = wrapper?.offsetParent;
    if (!(wrapper && sidebar)) {
      return;
    }
    const observer = new ResizeObserver(() => {
      setListMaxHeight(wrapper.offsetTop - CARD_GAP - CARD_HEADING_HEIGHT);
    });
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, [wrapper]);

  // The user-menu "Getting started" entry flips this to reopen the launcher.
  // gsRef avoids including the unstable `gs` object in deps.
  useEffect(() => {
    if (forceOpen) {
      gsRef.current.setState("expanded");
      setForceOpen(false);
    }
  }, [forceOpen, setForceOpen]);

  // Tells the user menu to open this card rather than the overlay.
  useEffect(() => {
    setDocked(true);
    return () => setDocked(false);
  }, [setDocked]);

  const path = pathname ?? "";
  if (!gs.isAuthenticated || isPreAppPath(path)) {
    return null;
  }
  if (gs.state === "dismissed") {
    return null;
  }

  // Lives in the sidebar, just above the Discord/Documentation footer. The pill
  // sits in-flow; the expanded card floats up from it (bottom-full) and bleeds
  // to the right over the canvas, which the sidebar does not clip.
  const { done, total } = checklistProgress(gs);
  return (
    <div className="relative px-2.5 pb-2" ref={setWrapper}>
      <AnimatePresence>
        {expanded && (
          <div className="absolute bottom-full left-2.5 z-50 mb-2">
            <ExpandedCard
              creditLabel={creditLabel}
              gs={gs}
              key="gs-card"
              listMaxHeight={listMaxHeight}
              onAction={onAction}
              onChip={onChip}
              onTour={onTour}
            />
          </div>
        )}
      </AnimatePresence>
      <button
        className={cn(
          "flex items-center gap-2 rounded-full border bg-popover shadow-sm transition-colors hover:bg-muted",
          compact ? "size-9 justify-center p-0" : "w-full py-2 pr-4 pl-3",
          expanded && "border-keeperhub-green"
        )}
        data-open={expanded}
        data-testid="gs-launcher-pill"
        onClick={() => gs.setState(expanded ? "collapsed" : "expanded")}
        type="button"
      >
        <ProgressRing done={done} total={total} />
        {compact ? null : (
          <>
            <Sparkles aria-hidden="true" className="size-3.5 text-primary" />
            <span className="truncate font-medium text-sm">
              Getting started {done}/{total}
            </span>
          </>
        )}
      </button>
    </div>
  );
}

/**
 * The checklist where the sidebar is not drawn (phones, settings), opened
 * from the user menu. It does not open, collapse or dismiss the card.
 */
export function GettingStartedOverlay({
  overlayId,
}: {
  overlayId: string;
}): React.ReactElement {
  const gs = useGettingStarted({ inOverlay: true });
  const creditLabel = useCreditLabel();
  const { onAction, onChip, onTour } = useStepActions(gs, { inOverlay: true });
  const [infoStep, setInfoStep] = useState<Step | null>(null);
  const { steps, done, total } = checklistProgress(gs);
  const docked = useAtomValue(gettingStartedDockedAtom);
  const expandLauncher = useSetAtom(gettingStartedOpenAtom);
  const { stack, close } = useOverlay();
  const onTop = stack.at(-1)?.id === overlayId;

  // Widening past 768px brings the sidebar back: hand over to its card, so
  // two copies of the checklist never save over each other. Not while a
  // step's window is open on top, which would lose what is in it.
  useEffect(() => {
    if (docked && onTop) {
      close(overlayId);
      expandLauncher(true);
    }
  }, [docked, onTop, close, overlayId, expandLauncher]);

  return (
    <Overlay
      description={`${done} of ${total} done`}
      overlayId={overlayId}
      title="Getting started"
    >
      <div className="-mx-2 space-y-1" data-testid="gs-overlay">
        <StepList
          gs={gs}
          onAction={onAction}
          onChip={onChip}
          onInfo={setInfoStep}
          onTour={onTour}
          steps={steps}
        />
      </div>
      <StepInfoDialog
        creditLabel={creditLabel}
        onAction={onAction}
        onClose={() => setInfoStep(null)}
        onTour={onTour}
        step={infoStep}
      />
    </Overlay>
  );
}
