"use client";

import { AnimatePresence, motion } from "motion/react";
import { LayoutRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { usePathname } from "next/navigation";
import { type ReactNode, useContext, useEffect, useRef } from "react";
import { WELCOME_STEPS } from "@/components/welcome/welcome-shell";

// Order used to decide the transition direction between wizard steps. Derived
// from the wizard itself so a new step cannot drift out of this list.
const STEP_ORDER: string[] = [
  "/welcome",
  ...WELCOME_STEPS.map((step) => step.path),
];

const variants = {
  enter: (direction: number) => ({
    opacity: 0,
    x: direction >= 0 ? 48 : -48,
  }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction >= 0 ? -48 : 48,
  }),
};

/**
 * Freezes the router context for the duration of an exit animation so the
 * outgoing step keeps rendering its own content instead of flashing the new
 * route's content mid-transition (the App Router + AnimatePresence gotcha).
 */
function FrozenRouter({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const context = useContext(LayoutRouterContext);
  const frozen = useRef(context).current;
  return (
    <LayoutRouterContext.Provider value={frozen}>
      {children}
    </LayoutRouterContext.Provider>
  );
}

/**
 * Slides the welcome/onboarding steps in and out based on navigation direction:
 * moving forward, the exiting step leaves to the left and the entering step
 * enters from the right; moving back reverses it.
 */
export default function WelcomeLayout({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  const pathname = usePathname();
  const prevRef = useRef(pathname);
  const direction =
    STEP_ORDER.indexOf(pathname) >= STEP_ORDER.indexOf(prevRef.current)
      ? 1
      : -1;

  useEffect(() => {
    prevRef.current = pathname;
  }, [pathname]);

  return (
    <div className="overflow-x-hidden">
      <AnimatePresence custom={direction} initial={false} mode="wait">
        <motion.div
          animate="center"
          custom={direction}
          exit="exit"
          initial="enter"
          key={pathname}
          transition={{ duration: 0.24, ease: "easeInOut" }}
          variants={variants}
        >
          <FrozenRouter>{children}</FrozenRouter>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
