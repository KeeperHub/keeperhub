"use client";

import qrcode from "qrcode-generator";
import { useMemo } from "react";

type Props = {
  data: string;
  size?: number;
};

/**
 * Renders an otpauth:// URI as an SVG QR code. Uses qrcode-generator
 * (kazuhikoarase, MIT) client-side: the URI never leaves the browser
 * tab where the user is enrolling, and we don't have to ship a
 * server-rendered QR over the wire alongside the secret.
 *
 * Error-correction level "L" is intentional — the QR is for short-
 * lived enrollment scan, not for a printed badge or weathered surface.
 * Lower correction means smaller, denser modules and fewer reads on a
 * mobile camera at a typical angle.
 */
export function TotpQr({ data, size = 192 }: Props): React.ReactElement {
  const svg = useMemo<string>(() => {
    const qr = qrcode(0, "L");
    qr.addData(data);
    qr.make();
    const moduleCount = qr.getModuleCount();
    const cellSize = size / moduleCount;
    const paths: string[] = [];
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) {
          const x = (col * cellSize).toFixed(2);
          const y = (row * cellSize).toFixed(2);
          const s = cellSize.toFixed(2);
          paths.push(`M${x} ${y}h${s}v${s}h-${s}z`);
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="white"/><path d="${paths.join("")}" fill="black"/></svg>`;
  }, [data, size]);

  return (
    <div
      aria-label="QR code for authenticator setup"
      className="inline-block rounded-md border bg-white p-2"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG is built locally from a static template + qrcode-generator output, no untrusted input.
      dangerouslySetInnerHTML={{ __html: svg }}
      role="img"
    />
  );
}
