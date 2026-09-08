import { atom } from "jotai";

/**
 * Gate for the root "/" canvas. The homepage decides, from the resolved
 * session and onboarding status, whether the user belongs on the canvas
 * ("canvas"), is being sent to the welcome flow ("redirecting"), or is still
 * being resolved ("loading"). PersistentCanvas reads this so the canvas is
 * never rendered on "/" until the decision is "canvas" -- there is nothing to
 * flash before a welcome redirect. Only "/" is gated; workflow pages always
 * render the canvas.
 */
export type RootGate = "loading" | "canvas" | "redirecting";

export const rootGateAtom = atom<RootGate>("loading");
