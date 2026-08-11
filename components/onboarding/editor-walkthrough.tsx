"use client";

import "driver.js/dist/driver.css";
import type { Alignment, Driver, Side } from "driver.js";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { api } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { runCreateWalletPath } from "@/lib/onboarding/paths/create-wallet";
import { toursDisabled } from "@/lib/onboarding/tours-disabled";
import { waitForAnchor } from "@/lib/onboarding/wait-for-anchor";
import {
  centerNodeAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  editorTourRequestedAtom,
  isExecutingAtom,
  nodesAtom,
  propertiesPanelActiveTabAtom,
  selectedNodeAtom,
  updateNodeDataAtom,
} from "@/lib/workflow/store";

const SEEN_KEY = "keeperhub-editor-tour-seen";
const TOUR_WORKFLOW_NAME = "Workflow Editor Tour";
// Sonner toast id for the "preparing the tour" loader shown during the async
// startup (wallet provisioning, anchor waits, driver.js dynamic import).
const TOUR_TOAST = "kh-tour-loading";
// The action grid stores an action's registry id (computeActionId = plugin/slug)
// in config.actionType, NOT its human label - so we match on the id here while
// the popover copy still says "Get Native Token Balance".
const BALANCE_ACTION = "web3/check-balance";
// A funded public mainnet address, so the run is green even when the user has
// no wallet of their own.
const FALLBACK_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const WALLET_ANCHOR = '[data-testid="wallet-toolbar-address"]';

type StepSnapshot = {
  selectedActionType: string | undefined;
  selectedNetwork: string | undefined;
  selectedAddress: string | undefined;
  isExecuting: boolean;
};

// "next": manual Next button. "auto": advances on an atom signal (isComplete).
// "dom-auto": advances when a DOM condition holds (isCompleteDom), e.g. a
// collapsible group has expanded. "finish": last step.
type StepMode = "next" | "auto" | "dom-auto" | "finish";

type StepDef = {
  id: string;
  selector: string;
  mode: StepMode;
  isComplete?: (snap: StepSnapshot) => boolean;
  isCompleteDom?: () => boolean;
  popover: { title: string; description: string; side: Side; align: Alignment };
};

const ORIENT_STEP: StepDef = {
  id: "orient",
  selector: ".react-flow__node-trigger",
  mode: "next",
  popover: {
    title: "Workflow Editor Tour",
    description:
      "Let's build a workflow that checks a wallet's balance, then run it. Every workflow is a Trigger (the when) wired to an Action (the what).",
    side: "right",
    align: "start",
  },
};

const WALLET_STEP: StepDef = {
  id: "wallet",
  selector: WALLET_ANCHOR,
  mode: "next",
  popover: {
    title: "Your wallet",
    description:
      "This is your wallet, and its address is saved in your address book. We'll check its balance in the next step.",
    side: "bottom",
    align: "end",
  },
};

const BALANCE_OPTION_SELECTOR = `[data-testid="action-option-${BALANCE_ACTION.toLowerCase()}"]`;

// 1) Orient the user to the whole action list (all the integrations).
const ACTIONS_INTRO_STEP: StepDef = {
  id: "actions-intro",
  selector: '[data-testid="action-grid"]',
  mode: "next",
  popover: {
    title: "Your connections",
    description:
      "These are the integrations you can act on, like Web3, Aave and Lido. Each one groups the actions it supports. Expand a group to see its actions, then click one to add it to this step.",
    side: "left",
    align: "start",
  },
};

// 2) Highlight only the Web3 group; advance once the user expands it (its
//    actions, including the target, appear in the DOM).
const OPEN_WEB3_STEP: StepDef = {
  id: "open-web3",
  selector: '[data-testid="action-group-web3"]',
  mode: "dom-auto",
  isCompleteDom: () => Boolean(document.querySelector(BALANCE_OPTION_SELECTOR)),
  popover: {
    title: "Open the Web3 group",
    description: "Click Web3 to expand it and reveal its actions.",
    side: "left",
    align: "start",
  },
};

// 3) Highlight the specific action; advance once it is added to the step.
const PICK_BALANCE_STEP: StepDef = {
  id: "pick-balance",
  selector: BALANCE_OPTION_SELECTOR,
  mode: "auto",
  isComplete: (snap) => snap.selectedActionType === BALANCE_ACTION,
  popover: {
    title: "Add the action",
    description:
      "Click Get Native Token Balance to add it to your step. It reads an on-chain balance.",
    side: "left",
    align: "start",
  },
};

// Guide the user to fill the two required fields themselves, so they learn what
// the step needs, instead of silently pre-filling them.
const SELECT_NETWORK_STEP: StepDef = {
  id: "select-network",
  selector: "#network",
  mode: "auto",
  isComplete: (snap) => Boolean(snap.selectedNetwork),
  popover: {
    title: "Pick a network",
    description:
      "Choose the chain to read the balance on. Ethereum Mainnet is a good default for this step.",
    side: "left",
    align: "start",
  },
};

const FILL_ADDRESS_STEP: StepDef = {
  id: "fill-address",
  selector: "#address",
  mode: "auto",
  isComplete: (snap) => Boolean(snap.selectedAddress),
  popover: {
    title: "Add a wallet address",
    description:
      "Paste the wallet to check. Copy your own address with the copy button next to the wallet in the top bar, then paste it here.",
    side: "left",
    align: "start",
  },
};

const RUN_STEP: StepDef = {
  id: "run",
  selector: '[data-tour="workflow-run"]',
  mode: "auto",
  isComplete: (snap) => snap.isExecuting,
  popover: {
    title: "Run it",
    description: "Click Run to check the balance live on-chain.",
    side: "bottom",
    align: "end",
  },
};

const RESULTS_STEP: StepDef = {
  id: "results",
  selector: '[data-testid="properties-panel"]',
  mode: "finish",
  popover: {
    title: "You ran your first workflow",
    description:
      "Green means success - the Runs tab here shows the balance and each step's output. That's the core loop: build, run, iterate.",
    side: "left",
    align: "start",
  },
};

function buildSteps(hasWallet: boolean): StepDef[] {
  const steps = [ORIENT_STEP];
  if (hasWallet) {
    steps.push(WALLET_STEP);
  }
  steps.push(
    ACTIONS_INTRO_STEP,
    OPEN_WEB3_STEP,
    PICK_BALANCE_STEP,
    SELECT_NETWORK_STEP,
    FILL_ADDRESS_STEP,
    RUN_STEP,
    RESULTS_STEP
  );
  return steps;
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "true");
  } catch {
    // Storage unavailable; nothing to persist.
  }
}

function buttonsFor(mode: StepMode): Array<"next" | "close"> {
  // Steps that advance programmatically (atom or DOM signal) only offer a way
  // out (Skip); manual steps also get Next.
  return mode === "auto" || mode === "dom-auto" ? ["close"] : ["next", "close"];
}

// Resolve the address to check: the user's first saved address book entry (their
// wallet) when present, otherwise a funded public address so the run still goes
// green. Returns the address plus whether the wallet toolbar is on screen.
async function resolveTourContext(
  signal: AbortSignal
): Promise<{ address: string; hasWallet: boolean }> {
  const hasWallet = Boolean(document.querySelector(WALLET_ANCHOR));
  let address = FALLBACK_ADDRESS;
  try {
    const response = await fetch("/api/address-book", {
      credentials: "same-origin",
      signal,
    });
    if (response.ok) {
      const entries: unknown = await response.json();
      const first = Array.isArray(entries) ? entries[0] : undefined;
      const entryAddress = (first as { address?: unknown } | undefined)
        ?.address;
      if (typeof entryAddress === "string" && entryAddress.length > 0) {
        address = entryAddress;
      }
    }
  } catch {
    // Address book unreachable; keep the fallback address.
  }
  return { address, hasWallet };
}

// Only org admins/owners can provision a wallet (matches the overlay's gate).
// "organization: update" is granted to admin + owner in the access control, so
// it stands in for isAdmin without mounting a global useActiveOrganization hook
// (which would 401 for anonymous visitors). Fetched lazily inside the launch.
async function canCreateWallet(): Promise<boolean> {
  try {
    const result = await authClient.organization.hasPermission({
      permissions: { organization: ["update"] },
    });
    const typed = result as {
      data?: { success?: boolean };
      success?: boolean;
    } | null;
    return Boolean(typed?.data?.success ?? typed?.success);
  } catch {
    return false;
  }
}

/**
 * Opt-in interactive walkthrough of the workflow editor. Launched by the
 * "Take a tour" button (which sets editorTourRequestedAtom and creates a fresh
 * default workflow). Drives driver.js step-by-step, advancing each action step
 * when the user actually performs it - observed read-only via the workflow
 * store, plus a few scripted writes (name the workflow, pre-fill the balance
 * network/address, open the Runs tab) so the first run is guaranteed green.
 * Signed-in only; anonymous users can't execute, so they get the sign-in card.
 */
export function EditorWalkthrough(): null {
  const { data: session } = useSession();
  const requested = useAtomValue(editorTourRequestedAtom);
  const setRequested = useSetAtom(editorTourRequestedAtom);
  const nodes = useAtomValue(nodesAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const isExecuting = useAtomValue(isExecutingAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const setNodeData = useSetAtom(updateNodeDataAtom);
  const setWorkflowName = useSetAtom(currentWorkflowNameAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const setCenterNode = useSetAtom(centerNodeAtom);
  const { closeAll } = useOverlay();

  const driverRef = useRef<Driver | null>(null);
  // Latest overlay-close fn, read inside launch without re-triggering the
  // one-shot launch effect (its deps stay narrow on purpose).
  const closeAllRef = useRef(closeAll);
  closeAllRef.current = closeAll;
  // Aborts the in-flight launch on unmount only - never on a re-render, so the
  // setRequested(false) / nodes updates during startup can't cancel the tour.
  const abortRef = useRef<AbortController | null>(null);
  // "idle" -> "starting" (async driver load) -> "running"
  const stateRef = useRef<"idle" | "starting" | "running">("idle");
  // Latest nodes for the pre-fill write without making the advance effect
  // depend on the (new-every-render) nodes array.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // The step list and resolved address are fixed once the tour starts.
  const stepsRef = useRef<StepDef[]>([]);
  // Advances "dom-auto" steps (e.g. waiting for the Web3 group to expand).
  const domObserverRef = useRef<MutationObserver | null>(null);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedConfig = selectedNode?.data.config as
    | { actionType?: unknown; network?: unknown; address?: unknown }
    | undefined;
  const selectedActionType =
    typeof selectedConfig?.actionType === "string"
      ? selectedConfig.actionType
      : undefined;
  const selectedNetwork =
    typeof selectedConfig?.network === "string" && selectedConfig.network
      ? selectedConfig.network
      : undefined;
  const selectedAddress =
    typeof selectedConfig?.address === "string" && selectedConfig.address
      ? selectedConfig.address
      : undefined;

  // Start the tour once a fresh default workflow is loaded and the user is
  // eligible. Consumes the request so it fires exactly once.
  useEffect(() => {
    if (stateRef.current !== "idle" || !requested) {
      return;
    }
    if (toursDisabled() || isAnonymousUser(session?.user)) {
      setRequested(false);
      return;
    }
    const hasTrigger = nodes.some((node) => node.data.type === "trigger");
    const hasAction = nodes.some((node) => node.data.type === "action");
    if (!(currentWorkflowId && hasTrigger && hasAction)) {
      return;
    }

    setRequested(false);
    stateRef.current = "starting";

    const controller = new AbortController();
    abortRef.current = controller;

    const launch = async (): Promise<void> => {
      toast.loading("Preparing your tour", { id: TOUR_TOAST });
      try {
        const context = await resolveTourContext(controller.signal);
        if (controller.signal.aborted) {
          stateRef.current = "idle";
          return;
        }
        let hasWallet = context.hasWallet;

        // No wallet yet: an admin can create one via the standalone Create Wallet
        // sub-path before we continue. Non-admins keep the public fallback address
        // (they can't provision a wallet), so the tour never dead-ends.
        if (!hasWallet && (await canCreateWallet())) {
          const result = await runCreateWalletPath({
            signal: controller.signal,
            closeOverlays: () => closeAllRef.current(),
          });
          if (controller.signal.aborted) {
            stateRef.current = "idle";
            return;
          }
          if (result === "done") {
            hasWallet = true;
          }
        }

        const steps = buildSteps(hasWallet);
        stepsRef.current = steps;

        // Name the tour workflow (display + persist; best-effort).
        setWorkflowName(TOUR_WORKFLOW_NAME);
        api.workflow
          .update(currentWorkflowId, { name: TOUR_WORKFLOW_NAME })
          .catch(() => {
            // Non-fatal: the tour still works with the default name.
          });

        // Center the trigger node so the opening spotlight is well-framed.
        const triggerNode = nodesRef.current.find(
          (node) => node.data.type === "trigger"
        );
        if (triggerNode) {
          setCenterNode(triggerNode.id);
        }

        const anchor = await waitForAnchor(
          steps[0].selector,
          controller.signal
        );
        if (controller.signal.aborted || !anchor) {
          stateRef.current = "idle";
          return;
        }

        // Let the center animation settle so the spotlight aligns to the node.
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (controller.signal.aborted) {
          stateRef.current = "idle";
          return;
        }

        const { driver } = await import("driver.js");
        if (controller.signal.aborted) {
          stateRef.current = "idle";
          return;
        }

        const instance = driver({
          allowClose: true,
          showProgress: false,
          doneBtnText: "Finish",
          nextBtnText: "Next",
          onDestroyed: () => {
            driverRef.current = null;
            domObserverRef.current?.disconnect();
            domObserverRef.current = null;
            stateRef.current = "idle";
            markSeen();
          },
          onHighlighted: () => {
            // If a dom-auto step's condition already holds on entry (the group
            // was already expanded), advance without waiting for a mutation.
            const active = driverRef.current;
            const index = active?.getActiveIndex();
            if (active && index !== undefined) {
              const current = stepsRef.current[index];
              if (current?.mode === "dom-auto" && current.isCompleteDom?.()) {
                setTimeout(() => driverRef.current?.moveNext(), 0);
              }
            }
          },
          steps: steps.map((step) => ({
            element: step.selector,
            popover: {
              title: step.popover.title,
              description: step.popover.description,
              side: step.popover.side,
              align: step.popover.align,
              showButtons: buttonsFor(step.mode),
            },
          })),
        });

        driverRef.current = instance;
        stateRef.current = "running";
        instance.drive();

        // Advance "dom-auto" steps off DOM changes (atom signals don't fire for
        // a collapsible group expanding). The active step is re-read each time.
        domObserverRef.current?.disconnect();
        const observer = new MutationObserver(() => {
          const active = driverRef.current;
          if (!active) {
            return;
          }
          const index = active.getActiveIndex();
          if (index === undefined) {
            return;
          }
          const current = stepsRef.current[index];
          if (current?.mode === "dom-auto" && current.isCompleteDom?.()) {
            active.moveNext();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        domObserverRef.current = observer;
      } finally {
        toast.dismiss(TOUR_TOAST);
      }
    };

    launch().catch(() => {
      stateRef.current = "idle";
    });
    // No cleanup here on purpose: the launch must survive the re-render that
    // setRequested(false) triggers (and frequent nodes updates). It is torn
    // down only on unmount, below.
  }, [
    requested,
    session,
    nodes,
    currentWorkflowId,
    setRequested,
    setWorkflowName,
    setCenterNode,
  ]);

  // Advance action steps when the user completes them. The successor of every
  // auto step is a non-auto step, so this can't double-advance.
  useEffect(() => {
    const instance = driverRef.current;
    if (stateRef.current !== "running" || !instance) {
      return;
    }
    const steps = stepsRef.current;
    const index = instance.getActiveIndex();
    if (index === undefined) {
      return;
    }
    const step = steps[index];

    // Recovery: on the pick step, adding a different action unmounts the grid
    // and breaks the spotlight, leaving the tour stuck. Clear the wrong action
    // so the grid returns, nudge the user to the right one, and re-anchor.
    if (
      step?.id === "pick-balance" &&
      selectedActionType &&
      selectedActionType !== BALANCE_ACTION
    ) {
      const wrong = nodesRef.current.find(
        (node) =>
          node.data.type === "action" &&
          node.data.config?.actionType === selectedActionType
      );
      if (wrong) {
        const config = (wrong.data.config ?? {}) as Record<string, unknown>;
        setNodeData({
          id: wrong.id,
          data: { config: { ...config, actionType: "" } },
        });
        setActiveTab("properties");
        toast.message("Pick Get Native Token Balance to continue the tour.", {
          id: "kh-tour-pick-hint",
        });
        setTimeout(() => driverRef.current?.refresh(), 120);
      }
      return;
    }

    if (step?.mode !== "auto" || !step.isComplete) {
      return;
    }
    if (
      !step.isComplete({
        selectedActionType,
        selectedNetwork,
        selectedAddress,
        isExecuting,
      })
    ) {
      return;
    }

    const nextId = steps[index + 1]?.id;

    // Entering the network field step: open the Properties tab so the Network /
    // Address fields the cards point at are on screen. The balance action is
    // already selected from the pick step, so its config is what the panel
    // shows. Do NOT pan the canvas here: these steps point at the right-hand
    // panel, and a canvas pan drags the spotlight onto the node instead.
    if (nextId === "select-network") {
      setActiveTab("properties");
    }

    // Entering results: surface the run output in the Runs tab.
    if (nextId === "results") {
      setActiveTab("runs");
    }

    const nextStep = steps[index + 1];

    // The next step's target can render a tick later (the config form, with the
    // Network / Address fields, appears just after the Properties tab is shown).
    // Advancing before it exists makes the driver float a detached popover, so
    // wait for the element and only then move on -- the current card stays put
    // until its successor has something real to point at.
    const signal = abortRef.current?.signal;
    if (nextStep && signal && !document.querySelector(nextStep.selector)) {
      waitForAnchor(nextStep.selector, signal)
        .then((anchor) => {
          if (anchor) {
            driverRef.current?.moveNext();
          }
        })
        .catch(() => {
          driverRef.current?.moveNext();
        });
      return;
    }

    instance.moveNext();
  }, [
    selectedActionType,
    selectedNetwork,
    selectedAddress,
    isExecuting,
    setNodeData,
    setActiveTab,
  ]);

  // Tear down a running tour if the controller unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      domObserverRef.current?.disconnect();
      driverRef.current?.destroy();
    };
  }, []);

  return null;
}
