"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { toChecksumAddress } from "@/lib/address-utils";

const COPIED_FEEDBACK_MS = 3000;

export function WalletAddressCard({
  walletAddress,
}: {
  walletAddress: string;
}): React.ReactElement {
  const checksummed = toChecksumAddress(walletAddress);
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = (): void => {
    navigator.clipboard.writeText(checksummed);
    toast.success("Address copied to clipboard");
    setCopied(true);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  return (
    <section>
      <div className="mb-2 font-medium text-sm">Wallet address</div>
      <button
        aria-label="Copy wallet address"
        className={`group flex w-full items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors duration-300 hover:bg-background ${
          copied
            ? "border-keeperhub-green/80 ring-1 ring-keeperhub-green/30"
            : "border-border"
        }`}
        data-testid="wallet-copy-address"
        onClick={handleCopy}
        type="button"
      >
        <code className="break-all font-mono text-foreground text-xs">
          {checksummed}
        </code>
        {copied ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-keeperhub-green/80" />
        ) : (
          <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
        )}
      </button>
      <p className="mt-2 text-muted-foreground text-xs">
        {copied ? "Copied to clipboard" : "Click to copy"}
      </p>
    </section>
  );
}
