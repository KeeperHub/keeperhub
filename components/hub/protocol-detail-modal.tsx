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
        // On phones the default 16px margin and 24px padding left the rows
        // too narrow, and the 16px close icon was the whole touch target.
        className="max-w-[calc(100%-1rem)] overflow-y-auto p-4 [-ms-overflow-style:none] [scrollbar-width:none] max-sm:*:data-[slot=dialog-close]:top-1 max-sm:*:data-[slot=dialog-close]:right-1 max-sm:*:data-[slot=dialog-close]:p-3.5 sm:max-w-4xl sm:p-6 [&::-webkit-scrollbar]:hidden"
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
