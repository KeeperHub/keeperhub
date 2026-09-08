"use client";

import { ArrowLeft } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { ConnectAuthPanel } from "@/components/auth/connect-auth-panel";
import { WalletPicker } from "@/components/auth/wallet-picker";
import { Button } from "@/components/ui/button";
import { resolvePostAuthDestination } from "@/lib/post-auth-destination";

/**
 * Single-column sign-in: a Google / GitHub / Wallet row, an "OR" divider, and
 * the email + password form (ConnectAuthPanel). Clicking Wallet reveals the
 * wallet picker; the height animates as the two views swap. Shared by the
 * welcome landing and the in-app Connect modal so both present the same
 * interface. On success the panel navigates home, where the onboarding gate
 * takes over.
 */
export function SignInChoices({
  redirectTo,
}: {
  // Where to land after a successful sign-in; forwarded to the email panel and
  // the wallet path. Defaults to the resolved post-auth destination.
  redirectTo?: string;
} = {}): React.ReactElement {
  const [showWallet, setShowWallet] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver(() => setHeight(el.scrollHeight));
    observer.observe(el);
    setHeight(el.scrollHeight);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div
      animate={{ height }}
      className="overflow-hidden"
      initial={false}
      transition={{ duration: 0.25, ease: "easeInOut" }}
    >
      <div ref={contentRef}>
        <AnimatePresence initial={false} mode="popLayout">
          {showWallet ? (
            <motion.div
              animate={{ opacity: 1 }}
              className="flex flex-col gap-4"
              exit={{ opacity: 0, transition: { duration: 0 } }}
              initial={{ opacity: 0 }}
              key="wallet"
              transition={{ opacity: { duration: 0.15, delay: 0.2 } }}
            >
              <p className="text-muted-foreground text-sm">
                Nothing leaves your device but a signature.
              </p>
              <WalletPicker
                onConnected={async () => {
                  window.location.assign(
                    redirectTo ?? (await resolvePostAuthDestination())
                  );
                }}
              />
              <Button
                className="w-full justify-center"
                onClick={() => setShowWallet(false)}
                type="button"
                variant="ghost"
              >
                <ArrowLeft className="size-4" />
                Other ways to sign in
              </Button>
            </motion.div>
          ) : (
            <motion.div
              animate={{ opacity: 1 }}
              className="flex flex-col gap-4"
              exit={{ opacity: 0, transition: { duration: 0 } }}
              initial={{ opacity: 0 }}
              key="socials"
              transition={{ opacity: { duration: 0.15, delay: 0.2 } }}
            >
              <ConnectAuthPanel
                hideChooserHeader
                onWalletClick={() => setShowWallet(true)}
                redirectTo={redirectTo}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
