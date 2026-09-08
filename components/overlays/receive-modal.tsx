"use client";

import { Check, Copy } from "lucide-react";
import qrcode from "qrcode-generator";
import { useMemo, useState } from "react";
import { Overlay } from "@/components/overlays/overlay";
import { Button } from "@/components/ui/button";
import { toChecksumAddress } from "@/lib/address-utils";

const COPIED_FOR_MS = 1500;
const QR_SIZE = 176;

function qrSvg(data: string): string {
  const qr = qrcode(0, "M");
  qr.addData(data);
  qr.make();
  const modules = qr.getModuleCount();
  const cell = QR_SIZE / modules;
  const paths: string[] = [];
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) {
        paths.push(
          `M${(col * cell).toFixed(2)} ${(row * cell).toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`
        );
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${QR_SIZE} ${QR_SIZE}" width="${QR_SIZE}" height="${QR_SIZE}"><rect width="${QR_SIZE}" height="${QR_SIZE}" fill="white"/><path d="${paths.join("")}" fill="black"/></svg>`;
}

/**
 * The receiving half of the wallet: the address to send funds to, as a code a
 * phone can read and as text a person can paste.
 */
export function ReceiveModal({
  overlayId,
  address,
  accountName,
  isEvm,
  /** Named only for a Safe, which lives on one network. */
  chainName,
}: {
  overlayId: string;
  address: string;
  accountName: string;
  isEvm: boolean;
  chainName?: string;
}): React.ReactElement {
  const display = isEvm ? toChecksumAddress(address) : address;
  const [copied, setCopied] = useState(false);
  const svg = useMemo(() => qrSvg(display), [display]);

  const copy = (): void => {
    navigator.clipboard.writeText(display);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_FOR_MS);
  };

  return (
    <Overlay overlayId={overlayId} title="Receive">
      <div className="flex flex-col items-center gap-4">
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="font-medium text-sm">{accountName}</span>
          <span className="text-muted-foreground text-xs">
            {chainName
              ? `Only send assets on ${chainName} to this address.`
              : isEvm
                ? "Works on every EVM network this organization supports."
                : "Solana network only."}
          </span>
        </div>

        {/* Built in the browser from an address already on screen. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: locally generated SVG, no untrusted input */}
        <div
          aria-label={`QR code for ${display}`}
          className="rounded-lg bg-white p-3"
          dangerouslySetInnerHTML={{ __html: svg }}
        />

        <code className="w-full break-all rounded-md border bg-muted/40 px-3 py-2 text-center font-mono text-xs">
          {display}
        </code>

        <Button className="w-full" onClick={copy} variant="outline">
          {copied ? (
            <Check className="size-4" />
          ) : (
            <Copy className="size-4" />
          )}
          {copied ? "Copied" : "Copy address"}
        </Button>
      </div>
    </Overlay>
  );
}
