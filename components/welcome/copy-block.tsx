"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * A labeled code block with a copy button. Used across the connect-agent step
 * for MCP setup commands and config snippets.
 */
export function CopyBlock({
  caption,
  body,
}: {
  caption?: string;
  body: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  return (
    <div className="w-full rounded-lg border border-border bg-muted/40">
      {caption ? (
        <div className="border-border border-b px-4 py-2 text-muted-foreground text-xs">
          {caption}
        </div>
      ) : null}
      {/* The gutter is on the wrapper, not the pre: padding inside a scroll
          container scrolls with the content, so a long command would pass under
          the copy button instead of stopping short of it. The mask fades the
          cut-off edge so a command that runs on does not look complete. */}
      <div className="relative pr-16">
        <pre className="overflow-x-auto whitespace-pre px-4 py-4 font-mono text-foreground text-xs leading-relaxed [mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)]">
          {body}
        </pre>
        <Button
          aria-label="Copy"
          className="absolute top-2.5 right-2.5"
          onClick={copy}
          size="icon"
          type="button"
          variant="outline"
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
