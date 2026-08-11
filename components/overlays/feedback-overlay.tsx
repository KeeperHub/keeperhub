"use client";

import { CheckCircle2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type FeedbackOverlayProps = {
  overlayId: string;
};

type FeedbackCategory = "bug" | "feature" | "question" | "feedback";

const CATEGORY_OPTIONS: { value: FeedbackCategory; label: string }[] = [
  { value: "bug", label: "bug" },
  { value: "feature", label: "feature" },
  { value: "question", label: "question" },
  { value: "feedback", label: "feedback" },
];

export function FeedbackOverlay({ overlayId }: FeedbackOverlayProps) {
  const { closeAll } = useOverlay();
  const [message, setMessage] = useState("");
  const [categories, setCategories] = useState<FeedbackCategory[]>([]);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const toggleCategory = (category: FeedbackCategory) => {
    setCategories((prev) =>
      prev.includes(category)
        ? prev.filter((c) => c !== category)
        : [...prev, category]
    );
  };

  const handleSubmit = async () => {
    if (!message.trim()) {
      toast.error("Please enter your feedback");
      return;
    }

    setSubmitting(true);

    try {
      const formData = new FormData();
      formData.append("message", message.trim());
      formData.append("categories", JSON.stringify(categories));
      if (screenshot) {
        formData.append("screenshot", screenshot);
      }

      const response = await fetch("/api/feedback", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to submit feedback");
      }

      await response.json();
      setSubmitted(true);
    } catch (error) {
      console.error("Failed to submit feedback:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to submit feedback"
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith("image/")) {
        toast.error("Please select an image file");
        return;
      }
      setScreenshot(file);
    }
  };

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          setScreenshot(file);
        }
        break;
      }
    }
  }, []);

  useEffect(() => {
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [handlePaste]);

  // Success state
  if (submitted) {
    return (
      <Overlay
        actions={[{ label: "Done", onClick: closeAll }]}
        overlayId={overlayId}
        title="Thank you!"
      >
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <CheckCircle2 className="mb-4 size-12 text-green-500" />
          <p className="mb-4 text-muted-foreground">
            Your issue has been created and will help us improve
          </p>
          <a
            className="text-primary text-sm underline"
            href="https://github.com/KeeperHub/keeperhub/issues?q=is%3Aopen+is%3Aissue+label%3Auser-feedback"
            rel="noopener noreferrer"
            target="_blank"
          >
            View all open issues
          </a>
        </div>
      </Overlay>
    );
  }

  return (
    <Overlay
      actions={[
        { label: "Close", variant: "outline", onClick: closeAll },
        {
          label: submitting ? "Submitting..." : "Submit",
          onClick: handleSubmit,
          disabled: submitting || !message.trim(),
        },
      ]}
      overlayId={overlayId}
      title="Submit a new issue"
    >
      <Label className="-mt-2 mb-4 block font-medium text-sm">
        The issue will be visible in our public GitHub repository
      </Label>

      {submitting ? (
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Message textarea */}
          <div className="space-y-2">
            <Textarea
              className="resize-none"
              id="feedback-message"
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Let us know what's on your mind..."
              rows={4}
              value={message}
            />
          </div>

          {/* Category pill buttons */}
          <div className="flex flex-wrap gap-2">
            {CATEGORY_OPTIONS.map((option) => {
              const isSelected = categories.includes(option.value);
              return (
                <button
                  className={cn(
                    "rounded-full px-3 py-1 font-medium text-sm transition-colors",
                    "border focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                    isSelected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-muted text-foreground/70 hover:bg-muted/80"
                  )}
                  key={option.value}
                  onClick={() => toggleCategory(option.value)}
                  type="button"
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          {/* Screenshot */}
          <div className="space-y-2">
            <Label className="font-medium text-sm">Screenshot (optional)</Label>
            {screenshot ? (
              <div className="relative rounded-md border bg-muted/50 p-2">
                {/* biome-ignore lint/performance/noImgElement: Next.js Image doesn't support blob URLs */}
                {/* biome-ignore lint/correctness/useImageSize: Dynamic blob preview has variable dimensions */}
                <img
                  alt="Screenshot preview"
                  className="max-h-32 rounded object-contain"
                  src={URL.createObjectURL(screenshot)}
                />
                <button
                  aria-label="Remove screenshot"
                  className="absolute top-1 right-1 rounded-full bg-background/80 p-1 text-muted-foreground hover:text-foreground"
                  onClick={() => setScreenshot(null)}
                  type="button"
                >
                  <svg
                    aria-hidden="true"
                    className="size-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M6 18L18 6M6 6l12 12"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                    />
                  </svg>
                </button>
                <p className="mt-1 truncate text-muted-foreground text-xs">
                  {screenshot.name || "Pasted image"}
                </p>
              </div>
            ) : (
              <div className="rounded-md border border-border border-dashed bg-muted/30 p-4 text-center">
                <p className="text-foreground text-sm">
                  Paste screenshot with{" "}
                  <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    ⌘V
                  </kbd>
                </p>
                <label
                  className="mt-2 inline-block cursor-pointer text-muted-foreground text-xs underline hover:text-foreground"
                  htmlFor="screenshot"
                >
                  or upload file
                </label>
                <input
                  accept="image/*"
                  className="hidden"
                  id="screenshot"
                  onChange={handleFileChange}
                  type="file"
                />
              </div>
            )}
          </div>
        </div>
      )}
    </Overlay>
  );
}
