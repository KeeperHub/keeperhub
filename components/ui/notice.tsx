import { AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";

type NoticeTone = "info" | "warning" | "danger";

const TONE_CLASS: Record<NoticeTone, string> = {
  info: "border-border bg-muted/30 text-muted-foreground",
  // No warning token exists yet, so the amber stays a palette class.
  warning:
    "border-yellow-500/40 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300",
  danger: "border-destructive/50 bg-destructive/15 text-foreground",
};

/** A small boxed note beside a field: a hint, a warning, or a problem. */
export function Notice({
  tone,
  children,
  className,
  role,
}: {
  tone: NoticeTone;
  children: React.ReactNode;
  className?: string;
  role?: "alert" | "status";
}): React.ReactElement {
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border p-2 text-xs",
        TONE_CLASS[tone],
        className
      )}
      role={role}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          tone === "danger" && "text-destructive"
        )}
      />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
