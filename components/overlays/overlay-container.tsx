"use client";

import type { Variants } from "motion/react";
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { useOverlay } from "./overlay-provider";
import type { OverlaySize } from "./types";
import { useSheetExpand, useSheetViewport } from "./use-sheet-expand";

const sizeClasses: Record<OverlaySize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "4xl": "max-w-4xl",
  full: "max-w-[90vw]",
};

// iOS-like spring configuration
const iosSpring = {
  type: "spring",
  stiffness: 400,
  damping: 35,
  mass: 0.8,
} as const;

// Softer spring for drawer
const drawerSpring = {
  type: "spring",
  stiffness: 350,
  damping: 30,
  mass: 0.8,
} as const;

/**
 * Variants for the dialog container (fade in/out)
 */
const containerVariants: Variants = {
  hidden: {
    opacity: 0,
    scale: 0.95,
  },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      type: "spring",
      stiffness: 400,
      damping: 30,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    transition: {
      duration: 0.15,
      ease: [0.4, 0, 1, 1],
    },
  },
};

/**
 * Variants for drawer container
 */
const _drawerContainerVariants: Variants = {
  hidden: {
    y: "100%",
    opacity: 0.5,
  },
  visible: {
    y: 0,
    opacity: 1,
    transition: drawerSpring,
  },
  exit: {
    y: "100%",
    opacity: 0.5,
    transition: {
      type: "spring",
      stiffness: 500,
      damping: 40,
    },
  },
};

/**
 * Get x position for overlay item based on its position relative to current
 */
function getOverlayXPosition(
  isCurrent: boolean,
  isPrevious: boolean
): "0%" | "-35%" | "100%" {
  if (isCurrent) {
    return "0%";
  }
  if (isPrevious) {
    return "-35%";
  }
  return "100%";
}

/**
 * Hook to track direction of stack changes (push vs pop)
 * Returns 1 for push, -1 for pop
 */
function useStackDirection(stackLength: number) {
  const prevLength = useRef(stackLength);
  const direction = useRef(1);

  // Compute synchronously during render for immediate value
  if (stackLength > prevLength.current) {
    direction.current = 1; // pushing
  } else if (stackLength < prevLength.current) {
    direction.current = -1; // popping
  }

  // Update prevLength after render
  useLayoutEffect(() => {
    prevLength.current = stackLength;
  }, [stackLength]);

  return direction.current;
}

/**
 * Desktop dialog container with internal sliding content
 * Renders all stack items persistently in the same React tree location,
 * using CSS transforms to animate visibility while preserving component state
 */
function DesktopOverlayContainer() {
  const { stack, closeAll, pop } = useOverlay();
  const shouldReduceMotion = useReducedMotion();
  const [minHeight, setMinHeight] = useState<number>(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const frozenStackRef = useRef(stack);
  const direction = useStackDirection(stack.length);

  const isOpen = stack.length > 0;

  // Freeze the stack when open so content doesn't shift during exit animation
  // AnimatePresence keeps children mounted during exit, so frozenStack is used then
  if (isOpen) {
    frozenStackRef.current = stack;
  }

  // Use frozen stack for rendering (preserves content during exit)
  const renderStack = frozenStackRef.current;
  const currentIndex = renderStack.length - 1;


  // Measure content height when it changes, reset on fresh open
  // biome-ignore lint/correctness/useExhaustiveDependencies: upstream code
  useLayoutEffect(() => {
    const isFreshOpen = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;

    // Reset minHeight on fresh open (not during push/pop)
    if (isFreshOpen) {
      setMinHeight(0);
    }

    if (contentRef.current) {
      const height = contentRef.current.offsetHeight;
      if (height > 0) {
        setMinHeight(height);
      }
    }
  }, [stack, isOpen]);

  // Track content size so the modal can shrink when the active view gets
  // shorter (e.g. switching tabs). Without this the minHeight latched on the
  // first measurement and content-light views showed a large empty area.
  useLayoutEffect(() => {
    if (!(isOpen && contentRef.current)) {
      return;
    }
    const node = contentRef.current;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (h > 0) {
          setMinHeight(h);
        }
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [isOpen]);

  // Use live stack for options checks (only when open)
  const currentItem = stack.at(-1);
  const springTransition = shouldReduceMotion ? { duration: 0.01 } : iosSpring;
  const isPushing = direction === 1;

  const handleBackdropClick = useCallback(() => {
    if (currentItem?.options.closeOnBackdropClick !== false) {
      closeAll();
    }
  }, [currentItem?.options.closeOnBackdropClick, closeAll]);

  const handleEscapeKey = useCallback(
    (e: KeyboardEvent) => {
      // A layer above the overlay - a dialog, a picker - that handled this
      // Escape marks it handled; it is not also a request to close the overlay.
      if (e.defaultPrevented) {
        return;
      }
      if (e.key === "Escape" && currentItem?.options.closeOnEscape !== false) {
        pop();
      }
    },
    [currentItem?.options.closeOnEscape, pop]
  );

  useLayoutEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleEscapeKey);
      return () => document.removeEventListener("keydown", handleEscapeKey);
    }
  }, [isOpen, handleEscapeKey]);

  const handleExitComplete = useCallback(() => {
    frozenStackRef.current = [];
  }, []);

  // Don't render Dialog at all when closed - this ensures clean unmount
  if (!isOpen && frozenStackRef.current.length === 0) {
    return null;
  }

  return (
    <AnimatePresence onExitComplete={handleExitComplete}>
      {isOpen && (
        <Dialog modal={false} open>
          <DialogPortal forceMount>
            {/* Backdrop - standalone clickable div */}
            <motion.div
              animate={{ opacity: 1 }}
              className="fixed inset-0 z-50 bg-black/60"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              onClick={handleBackdropClick}
              transition={{ duration: 0.2 }}
            />

            {/* Dialog container. While it holds a code entry on a touch
                screen, py-4 keeps the card's shadow clear of the edge when
                keyboard-safe-window makes it scroll. */}
            <motion.div
              animate="visible"
              className={cn(
                "-translate-x-1/2 -translate-y-1/2 keyboard-safe-window fixed top-1/2 left-1/2 z-50 w-full px-4 soft-keyboard:has-[[data-keyboard-safe]]:py-4",
                sizeClasses[currentItem?.options.size || "lg"]
              )}
              data-testid="overlay-window"
              exit="exit"
              initial="hidden"
              variants={containerVariants}
            >
              <LayoutGroup>
                <motion.div
                  className="relative max-h-[85vh] overflow-hidden rounded-xl border bg-background shadow-2xl ring-1 ring-black/5"
                  layout={isOpen}
                  style={{ minHeight: minHeight > 0 ? minHeight : "auto" }}
                  transition={iosSpring}
                >
                  {/* Content area - all items rendered persistently to preserve state */}
                  <div className="relative" ref={contentRef}>
                    {renderStack.map((item, index) => {
                      const isCurrent = index === currentIndex;
                      const isPrevious = index < currentIndex;

                      // For push onto existing stack: new current item slides in from right
                      // For first overlay (fresh open): no slide, dialog container handles entrance
                      // For pop: returning item is already at -35%, animates to 0%
                      const shouldSlideIn =
                        isCurrent && isPushing && renderStack.length > 1;
                      const initialValue = shouldSlideIn
                        ? { x: "100%", scale: 1, opacity: 1 }
                        : false;

                      return (
                        <motion.div
                          animate={{
                            x: getOverlayXPosition(isCurrent, isPrevious),
                            scale: isCurrent ? 1 : 0.94,
                            opacity: isCurrent ? 1 : 0,
                          }}
                          aria-hidden={!isCurrent}
                          className={cn(
                            "w-full",
                            isCurrent
                              ? "relative"
                              : "pointer-events-none absolute inset-0"
                          )}
                          initial={initialValue}
                          key={item.id}
                          transition={springTransition}
                        >
                          <item.component overlayId={item.id} {...item.props} />
                        </motion.div>
                      );
                    })}
                  </div>
                </motion.div>
              </LayoutGroup>
            </motion.div>
          </DialogPortal>
        </Dialog>
      )}
    </AnimatePresence>
  );
}

// Presses on and around a phone sheet are ignored this long after it opens,
// so the second tap of a double tap that opened it neither closes it nor hits
// a control the sheet slid under the finger.
const OPEN_PRESS_GRACE_MS = 400;

type OutsidePress = CustomEvent<{ originalEvent: PointerEvent }>;

// Whether a point is on the sheet: in its rounded top corners only inside the
// curve, since the backdrop shows (and takes taps) outside it.
function isOnSheet(sheet: HTMLElement, x: number, y: number): boolean {
  const rect = sheet.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    return false;
  }
  const radius =
    Number.parseFloat(getComputedStyle(sheet).borderTopLeftRadius) || 0;
  const curveY = rect.top + radius;
  if (y >= curveY) {
    return true;
  }
  let curveX = x;
  if (x < rect.left + radius) {
    curveX = rect.left + radius;
  } else if (x > rect.right - radius) {
    curveX = rect.right - radius;
  }
  return Math.hypot(x - curveX, y - curveY) <= radius;
}

/**
 * The phone sheet's grace after opening: `settling` turns presses on it off,
 * `sheetRef` and `start` begin the grace (on mount, and on a reopen during
 * the close animation), and `onPointerDownOutside` drops presses that came
 * within it or landed on the sheet itself.
 */
function useOpenPressGrace(): {
  settling: boolean;
  start: () => void;
  sheetRef: (node: HTMLDivElement | null) => void;
  onPointerDownOutside: (event: OutsidePress) => void;
} {
  const [settling, setSettling] = useState(false);
  const openedAtRef = useRef(0);
  const sheetNodeRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = useCallback(() => {
    openedAtRef.current = performance.now();
    setSettling(true);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(
      () => setSettling(false),
      OPEN_PRESS_GRACE_MS
    );
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    []
  );

  // Vaul mounts the sheet a render after opening, so its grace starts here,
  // and again on its first frame: a slow render must not use the grace up.
  const sheetRef = useCallback(
    (node: HTMLDivElement | null) => {
      sheetNodeRef.current = node;
      if (node) {
        start();
        requestAnimationFrame(start);
      }
    },
    [start]
  );

  const onPointerDownOutside = useCallback((event: OutsidePress) => {
    const press = event.detail.originalEvent;
    // Radix reports a press on the click after it, so time the press itself
    // (capped at now, should a browser use another clock).
    const pressedAt = Math.min(press.timeStamp, performance.now());
    const sheet = sheetNodeRef.current;
    const onSheet =
      sheet !== null && isOnSheet(sheet, press.clientX, press.clientY);
    if (onSheet || pressedAt - openedAtRef.current < OPEN_PRESS_GRACE_MS) {
      event.preventDefault();
    }
  }, []);

  return { settling, start, sheetRef, onPointerDownOutside };
}

/**
 * Mobile drawer container with internal sliding content
 * Renders all stack items persistently in the same React tree location,
 * using CSS transforms to animate visibility while preserving component state
 */
function MobileOverlayContainer() {
  const { stack, closeAll, pop } = useOverlay();
  const shouldReduceMotion = useReducedMotion();
  const [minHeight, setMinHeight] = useState<number>(0);
  const contentRef = useRef<HTMLDivElement>(null);
  // State, not a ref: Vaul mounts the sheet a render after it opens.
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);
  const grace = useOpenPressGrace();
  const frozenStackRef = useRef(stack);
  const direction = useStackDirection(stack.length);

  const isOpen = stack.length > 0;
  const [expanded, setExpanded, expandedRef] = useSheetExpand(sheet);
  useSheetViewport(sheet?.parentElement ?? null);

  // Freeze the stack when open so content doesn't shift during exit animation
  if (isOpen) {
    frozenStackRef.current = stack;
  }

  // Use frozen stack for rendering (preserves content during exit)
  const renderStack = frozenStackRef.current;
  const currentIndex = renderStack.length - 1;

  // Measure content height when it changes, reset on fresh open
  // biome-ignore lint/correctness/useExhaustiveDependencies: upstream code
  useLayoutEffect(() => {
    const isFreshOpen = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;

    // Reset minHeight on fresh open (not during push/pop)
    const reopenedFullScreen = isFreshOpen && expandedRef.current;
    if (isFreshOpen) {
      setMinHeight(0);
      grace.start();
      // Reset here, not on close, so the exit slides out at full screen.
      setExpanded(false);
    }

    // Reopened before the exit ended, the content still has its full screen
    // size; the ResizeObserver measures it once it is back to its own.
    if (contentRef.current && !expandedRef.current && !reopenedFullScreen) {
      const height = contentRef.current.offsetHeight;
      if (height > 0) {
        setMinHeight(height);
      }
    }
  }, [stack, isOpen]);

  // Track content size so the drawer can shrink when the active view gets
  // shorter (e.g. switching tabs).
  useLayoutEffect(() => {
    if (!(isOpen && contentRef.current)) {
      return;
    }
    const node = contentRef.current;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        // Full screen stretches the content; keep the height it has on its own.
        if (h > 0 && !expandedRef.current) {
          setMinHeight(h);
        }
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [isOpen, expandedRef]);

  // Use live stack for options checks (only when open)
  const currentItem = stack.at(-1);
  const renderCurrentItem = renderStack[currentIndex];
  const springTransition = shouldReduceMotion ? { duration: 0.01 } : iosSpring;
  const isPushing = direction === 1;

  const handleEscapeKey = useCallback(
    (e: KeyboardEvent) => {
      // A layer above the overlay - a dialog, a picker - that handled this
      // Escape marks it handled; it is not also a request to close the overlay.
      if (e.defaultPrevented) {
        return;
      }
      if (e.key === "Escape" && currentItem?.options.closeOnEscape !== false) {
        pop();
      }
    },
    [currentItem?.options.closeOnEscape, pop]
  );

  useLayoutEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleEscapeKey);
      return () => document.removeEventListener("keydown", handleEscapeKey);
    }
  }, [isOpen, handleEscapeKey]);

  // Clear frozen stack after drawer closes
  const handleAnimationEnd = useCallback(() => {
    if (!isOpen) {
      frozenStackRef.current = [];
    }
  }, [isOpen]);

  return (
    <DrawerPrimitive.Root
      onAnimationEnd={handleAnimationEnd}
      onOpenChange={(open) => {
        if (!open) {
          closeAll();
        }
      }}
      open={isOpen}
    >
      <DrawerPrimitive.Portal>
        {/* Backdrop - let Vaul handle animations */}
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />

        {/* Drawer container - let Vaul handle open/close animations */}
        <DrawerPrimitive.Content
          className={cn(
            "fixed inset-x-0 z-50 flex flex-col border-t bg-background shadow-2xl",
            // Sized from the visible viewport above any on-screen keyboard,
            // over Vaul's own inline keyboard sizing.
            "bottom-[var(--sheet-keyboard,0px)]! h-auto!",
            expanded ? "rounded-none border-t-0" : "rounded-t-2xl"
          )}
          data-testid="overlay-sheet"
          onPointerDownOutside={grace.onPointerDownOutside}
          ref={grace.sheetRef}
          // Presses on the settling sheet fall through to the backdrop below
          style={grace.settling ? { pointerEvents: "none" } : undefined}
        >
          {/* Accessible title for screen readers */}
          <DrawerPrimitive.Title className="sr-only">
            {renderCurrentItem?.options.title || "Dialog"}
          </DrawerPrimitive.Title>

          {/* Vaul's inline transition on Content would cancel this one, so the
              height change animates here. --sheet-room is the height left for
              the content under the handle, which caps the measured minHeight.
              Full screen, Vaul does not drag (a swipe down collapses instead)
              and the sheet stops under the app banner, which stays on top. */}
          <div
            className={cn(
              "group/sheet flex flex-col pb-(--sheet-pad) transition-[min-height,max-height,padding-top] duration-300 ease-out [--sheet-pad:max(0px,calc(env(safe-area-inset-bottom)-var(--sheet-keyboard,0px)))] [--sheet-handle:--spacing(4.5)] [--sheet-room:calc(var(--sheet-max)-var(--sheet-handle)-var(--sheet-pad))] motion-reduce:transition-none",
              expanded
                ? "max-h-(--sheet-max) min-h-(--sheet-max) pt-[max(0px,calc(env(safe-area-inset-top)-var(--app-banner-height,0px)))] [--sheet-max:calc(var(--sheet-viewport,100dvh)-var(--app-banner-height,0px))]"
                : "max-h-(--sheet-max) min-h-0 [--sheet-max:min(90vh,calc(var(--sheet-viewport,100dvh)-2rem))]"
            )}
            data-expanded={expanded}
            data-sheet=""
            data-vaul-no-drag={expanded ? "" : undefined}
            ref={setSheet}
          >
            {/* Drag handle; tapping it toggles full screen. The ::after makes
                the tap area 42px tall, into the header's top padding. */}
            <button
              aria-label="Full screen"
              aria-pressed={expanded}
              className="relative z-10 mx-auto flex h-(--sheet-handle) w-24 shrink-0 items-end justify-center rounded-full after:absolute after:inset-x-0 after:top-0 after:-bottom-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="overlay-sheet-handle"
              onClick={() => setExpanded(!expanded)}
              type="button"
            >
              <span className="h-1.5 w-12 rounded-full bg-muted-foreground/20" />
            </button>

            {/* Content area with height animation */}
            <LayoutGroup>
              <motion.div
                className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
                layout={isOpen}
                style={{
                  minHeight:
                    minHeight > 0 && !expanded
                      ? `min(${minHeight}px, var(--sheet-room))`
                      : "auto",
                }}
                transition={shouldReduceMotion ? { duration: 0 } : drawerSpring}
              >
                {/* Content wrapper - all items rendered persistently to preserve state */}
                {/* Content can shrink to fit a capped sheet, and grows to fill
                    it full screen. */}
                <div
                  className={cn(
                    "relative flex min-h-0 flex-col",
                    expanded && "flex-1"
                  )}
                  ref={contentRef}
                >
                  {renderStack.map((item, index) => {
                    const isCurrent = index === currentIndex;
                    const isPrevious = index < currentIndex;

                    // For push onto existing stack: new current item slides in from right
                    // For first overlay (fresh open): no slide, drawer container handles entrance
                    // For pop: returning item is already at -35%, animates to 0%
                    const shouldSlideIn =
                      isCurrent && isPushing && renderStack.length > 1;
                    const initialValue = shouldSlideIn
                      ? { x: "100%", scale: 1, opacity: 1 }
                      : false;

                    return (
                      <motion.div
                        animate={{
                          x: getOverlayXPosition(isCurrent, isPrevious),
                          scale: isCurrent ? 1 : 0.94,
                          opacity: isCurrent ? 1 : 0,
                        }}
                        aria-hidden={!isCurrent}
                        className={cn(
                          // The overlay's root can shrink above a keyboard,
                          // and fills the sheet full screen.
                          "flex w-full min-h-0 flex-col [&>*]:min-h-0",
                          isCurrent
                            ? "relative"
                            : "pointer-events-none absolute inset-0",
                          expanded && "flex-1 [&>*]:max-h-none [&>*]:flex-1"
                        )}
                        initial={initialValue}
                        key={item.id}
                        transition={springTransition}
                      >
                        <item.component overlayId={item.id} {...item.props} />
                      </motion.div>
                    );
                  })}
                </div>
              </motion.div>
            </LayoutGroup>
          </div>
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}

/**
 * Container component that renders overlays.
 * Place this once at the app level (inside OverlayProvider).
 */
export function OverlayContainer() {
  const isMobile = useIsMobile();

  if (isMobile) {
    return <MobileOverlayContainer />;
  }

  return <DesktopOverlayContainer />;
}
