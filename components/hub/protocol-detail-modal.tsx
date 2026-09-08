"use client";

import { useCallback, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ProtocolDefinition } from "@/lib/protocol-registry";
import { ProtocolDetail } from "./protocol-detail";

type ProtocolDetailModalProps = {
  protocol: ProtocolDefinition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ProtocolDetailModal({
  protocol,
  open,
  onOpenChange,
}: ProtocolDetailModalProps): React.ReactElement {
  const [lockedHeight, setLockedHeight] = useState<number | undefined>(
    undefined
  );
  const contentRef = useRef<HTMLDivElement>(null);

  const captureHeight = useCallback((): void => {
    const el = contentRef.current;
    if (el && lockedHeight === undefined) {
      const maxAllowed = window.innerHeight * 0.8;
      setLockedHeight(Math.min(el.scrollHeight, maxAllowed));
    }
  }, [lockedHeight]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      if (!nextOpen) {
        setLockedHeight(undefined);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent
        className="overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:max-w-4xl"
        ref={contentRef}
        style={{
          maxHeight: "80vh",
          minHeight: lockedHeight ? `${lockedHeight}px` : undefined,
        }}
      >
        <DialogTitle className="sr-only">
          {protocol?.name ?? "Protocol Details"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {protocol?.description ?? "Protocol actions and details"}
        </DialogDescription>
        {protocol && (
          <ProtocolDetail
            hideBackButton
            onTabChange={captureHeight}
            protocol={protocol}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
