"use client";

import { ShieldCheck } from "lucide-react";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { DeploySafeFlow } from "@/components/safe/deploy-safe-card";

export function DeploySafeOverlay({
  overlayId,
  isOwner,
  onChanged,
}: {
  overlayId: string;
  isOwner: boolean;
  onChanged: () => void;
}): React.ReactElement {
  const { pop } = useOverlay();
  const close = (): void => {
    onChanged();
    pop();
  };

  return (
    <Overlay overlayId={overlayId} title="Deploy a Safe">
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium text-sm">Safe smart account</h3>
        </div>
        <p className="text-muted-foreground text-xs">
          Deploy a Safe smart wallet on-chain per network. Safes can hold funds
          and sign workflow transactions independently from the Turnkey EOA.
        </p>
        {isOwner ? (
          <DeploySafeFlow onCancel={close} onComplete={close} />
        ) : (
          <p className="text-muted-foreground text-xs">
            Only the organization owner can deploy a Safe.
          </p>
        )}
      </div>
    </Overlay>
  );
}
