"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { ScanLanding } from "@/components/scan/scan-landing";
import { Spinner } from "@/components/ui/spinner";
import { useSession } from "@/lib/auth-client";
import { useStartBuilding } from "@/lib/hooks/use-start-building";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { rootGateAtom } from "@/lib/onboarding/root-gate";
import { isContinueAsGuest } from "@/lib/welcome-status";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  edgesAtom,
  editorTourRequestedAtom,
  hasSidebarBeenShownAtom,
  nodesAtom,
  type WorkflowNode,
} from "@/lib/workflow/store";

const Home = () => {
  const router = useRouter();
  const { data: session, isPending: sessionPending } = useSession();
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setCurrentWorkflowId = useSetAtom(currentWorkflowIdAtom);
  const setCurrentWorkflowName = useSetAtom(currentWorkflowNameAtom);
  const setHasSidebarBeenShown = useSetAtom(hasSidebarBeenShownAtom);
  const tourRequested = useAtomValue(editorTourRequestedAtom);
  const { startBuilding } = useStartBuilding();

  // Reset sidebar animation state when on homepage
  useEffect(() => {
    setHasSidebarBeenShown(false);
  }, [setHasSidebarBeenShown]);

  // Welcome gating: a visitor without a real session (none, or anonymous) lands
  // on the welcome page instead of the bare canvas, unless they explicitly chose
  // to continue without an account. A signed-in user who has not gone through
  // the onboarding wizard is sent into it. Until the session resolves and this
  // decision is made we render a loader over the canvas, so a redirected user
  // never sees the canvas flash before being sent to /welcome.
  const welcomeRedirectedRef = useRef(false);
  const [gate, setGate] = useAtom(rootGateAtom);
  useEffect(() => {
    if (sessionPending || welcomeRedirectedRef.current) {
      return;
    }
    const isSignedIn =
      Boolean(session?.user) && !isAnonymousUser(session?.user);
    if (!isSignedIn) {
      if (isContinueAsGuest()) {
        setGate("canvas");
      } else {
        welcomeRedirectedRef.current = true;
        setGate("redirecting");
        router.replace("/welcome");
      }
      return;
    }
    // A real user who has not completed onboarding (new signup, or an anonymous
    // guest who just signed in) is sent into the wizard. The server flag is
    // authoritative so this is not skipped by a stale device flag.
    const onboardingDone =
      (session?.user as { onboardingCompleted?: boolean } | undefined)
        ?.onboardingCompleted === true;
    if (onboardingDone) {
      setGate("canvas");
    } else {
      welcomeRedirectedRef.current = true;
      setGate("redirecting");
      router.replace("/welcome/create-org");
    }
  }, [sessionPending, session, router, setGate]);

  // Launch the editor walkthrough when "Take a tour" was requested (from the
  // account menu or the Setup Guide): build the fresh default workflow the
  // walkthrough controller drives. startBuilding then navigates into the editor.
  const startBuildingRef = useRef(startBuilding);
  startBuildingRef.current = startBuilding;

  useEffect(() => {
    if (tourRequested && session && !isAnonymousUser(session.user)) {
      startBuildingRef.current().catch(() => {
        // Errors are surfaced via toast inside startBuilding.
      });
    }
  }, [tourRequested, session]);

  // Canvas-atom reset on mount. The canvas never mounts on "/" (the scan
  // landing owns it), but the reset still matters: it clears any workflow
  // state left behind by a previous /workflows/{id} visit (toolbar, autosave).
  useEffect(() => {
    const addNodePlaceholder: WorkflowNode = {
      id: "add-node-placeholder",
      type: "add",
      position: { x: 0, y: 0 },
      data: {
        label: "",
        type: "add",
        onClick: () => {
          startBuildingRef.current().catch(() => {
            // Errors are surfaced via toast inside startBuilding.
          });
        },
      },
      draggable: false,
      selectable: false,
    };
    setNodes([addNodePlaceholder]);
    setEdges([]);
    setCurrentWorkflowId(null);
    setCurrentWorkflowName("New Workflow");
  }, [setNodes, setEdges, setCurrentWorkflowId, setCurrentWorkflowName]);

  // Until the session/onboarding gate resolves, cover the layout's
  // PersistentCanvas with a loader so a redirected user never sees a canvas
  // (or scan landing) flash before /welcome.
  if (gate !== "canvas") {
    return (
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-background">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  return (
    <Suspense fallback={null}>
      <ScanLanding />
    </Suspense>
  );
};

export default Home;
