"use client";

import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import type { OverlayComponentProps } from "@/components/overlays/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SOCIAL_LINKS, SUPPORT_EMAIL } from "@/lib/social-links";

const CATEGORIES = [
  "Getting started",
  "Wallet",
  "Workflows",
  "Billing",
  "Other",
] as const;

const LINK_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground";

/**
 * Contact-support surface (KEEP-869): a short message form that posts to the
 * existing `/api/feedback` route plus the community channels, so a stuck user
 * can always reach a human. Opened as an overlay from the user menu and the
 * getting-started launcher.
 */
export function ContactSupportDialog({
  overlayId,
}: OverlayComponentProps): React.ReactElement {
  const { closeAll } = useOverlay();
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = message.trim();
    if (!trimmed) {
      toast.error("Please enter a message.");
      return;
    }
    setSending(true);
    try {
      const formData = new FormData();
      formData.append("message", trimmed);
      if (category) {
        formData.append("categories", category);
      }
      const res = await fetch("/api/feedback", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(
          data.error ?? "Could not send your message. Try a channel below."
        );
        return;
      }
      toast.success("Message sent. We'll get back to you.");
      closeAll();
    } finally {
      setSending(false);
    }
  };

  return (
    <Overlay
      actions={[{ label: "Close", variant: "outline", onClick: closeAll }]}
      description="Send us a message or reach the team on any channel below."
      overlayId={overlayId}
      title="Contact support"
    >
      <div className="space-y-6">
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="contact-message">How can we help?</Label>
            <Textarea
              id="contact-message"
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Describe what you're stuck on..."
              rows={4}
              value={message}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="contact-category">Topic (optional)</Label>
            <Select onValueChange={setCategory} value={category}>
              <SelectTrigger className="w-full" id="contact-category">
                <SelectValue placeholder="Choose a topic" />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            className="w-full"
            disabled={sending || !message.trim()}
            onClick={submit}
          >
            {sending ? "Sending..." : "Send message"}
          </Button>
        </div>

        <div className="space-y-2">
          <p className="font-medium text-sm">Community &amp; support</p>
          <div className="flex flex-wrap gap-2">
            {SOCIAL_LINKS.map((link) => (
              <a
                className={LINK_CLASS}
                href={link.href}
                key={link.brand}
                rel="noopener"
                target="_blank"
              >
                {link.label}
                <ExternalLink className="size-3" />
              </a>
            ))}
            <a className={LINK_CLASS} href={`mailto:${SUPPORT_EMAIL}`}>
              Email us
            </a>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
