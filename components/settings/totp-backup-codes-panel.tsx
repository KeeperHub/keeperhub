"use client";

import { Check, Copy, Download, KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type Props = {
  codes: string[] | null;
  onGenerate?: () => Promise<void> | void;
  generateLabel?: string;
};

function downloadAsText(codes: string[]): void {
  const content = [
    "KeeperHub two-factor authentication backup codes",
    `Generated: ${new Date().toISOString()}`,
    "",
    "Each code can be used once if you lose access to your authenticator.",
    "Keep this file secret.",
    "",
    ...codes.map(
      (code, idx) => `${(idx + 1).toString().padStart(2, " ")}. ${code}`
    ),
    "",
  ].join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "keeperhub-backup-codes.txt";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Two-phase backup-codes UX:
 *
 *   1. PRE-GENERATE — codes are not on the wire yet. Shows a single
 *      "Generate" call-to-action. Only rendered if `onGenerate` is
 *      provided (the regenerate-later flow); the enrollment flow
 *      receives pre-fetched codes and skips this phase.
 *
 *   2. EXPORT — codes are visible with Copy + Download buttons. A
 *      successful Download fires `onConfirmed` so the container can
 *      close the dialog. Copy is offered as a convenience but does
 *      not fire `onConfirmed`. The container is expected to provide
 *      a separate Skip control for users who want to dismiss without
 *      downloading.
 */
export function TotpBackupCodesPanel({
  codes,
  onGenerate,
  generateLabel,
}: Props): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [generating, setGenerating] = useState(false);

  if (codes === null) {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertDescription>
            Backup codes are hidden until you choose to generate them. Once
            shown they cannot be re-viewed — you'll need to save them
            immediately.
          </AlertDescription>
        </Alert>
        <div className="flex flex-col items-center gap-3 rounded-md border bg-muted/30 p-6">
          <KeyRound
            aria-hidden="true"
            className="size-8 text-muted-foreground"
          />
          <p className="text-center font-mono text-muted-foreground text-sm">
            ●●●●●-●●●●● ●●●●●-●●●●●
          </p>
          <Button
            disabled={generating || !onGenerate}
            onClick={async () => {
              if (!onGenerate) {
                return;
              }
              setGenerating(true);
              try {
                await onGenerate();
              } finally {
                setGenerating(false);
              }
            }}
          >
            {generating ? "Generating..." : (generateLabel ?? "Generate codes")}
          </Button>
        </div>
      </div>
    );
  }

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      toast.success("Backup codes copied to clipboard");
    } catch {
      toast.error("Copy failed — use the download button instead");
    }
  };

  const handleDownload = (): void => {
    try {
      downloadAsText(codes);
      setDownloaded(true);
      toast.success("Backup codes downloaded");
    } catch {
      toast.error("Download failed");
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 font-mono text-xs">
        {codes.map((code, idx) => (
          <div className="flex gap-2" key={code}>
            <span className="text-muted-foreground">
              {(idx + 1).toString().padStart(2, " ")}.
            </span>
            <span>{code}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          className="w-full"
          onClick={handleCopy}
          variant={copied ? "outline" : "ghost"}
        >
          {copied ? (
            <Check aria-hidden="true" className="mr-2 size-4" />
          ) : (
            <Copy aria-hidden="true" className="mr-2 size-4" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          className="w-full"
          onClick={handleDownload}
          variant={downloaded ? "outline" : "default"}
        >
          {downloaded ? (
            <Check aria-hidden="true" className="mr-2 size-4" />
          ) : (
            <Download aria-hidden="true" className="mr-2 size-4" />
          )}
          {downloaded ? "Downloaded" : "Download .txt"}
        </Button>
      </div>
    </div>
  );
}
