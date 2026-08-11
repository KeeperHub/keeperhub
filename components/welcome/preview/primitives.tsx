import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

type IconType = ComponentType<{ className?: string }>;

// Fade the mock from opaque on the left (where the highlighted control sits) to
// transparent on the right. The left 3/5 stays solid; only the right ~2/5 fades.
const RIGHT_FADE = "linear-gradient(to right, black 60%, transparent 90%)";

/** Atom: a greyed placeholder bar standing in for real content. */
export function SkeletonBar({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return <div className={cn("rounded bg-muted-foreground/10", className)} />;
}

/** Atom: the rounded, bordered "window" a preview is framed in. */
export function PreviewFrame({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-2xl border border-border shadow-2xl",
        className
      )}
    >
      {children}
    </div>
  );
}

/** Atom: a sidebar navigation row (icon + label), optionally active. */
export function PreviewNavRow({
  icon: Icon,
  label,
  active = false,
}: {
  icon: IconType;
  label: string;
  active?: boolean;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-xs",
        active
          ? "bg-primary/15 font-medium text-primary"
          : "text-muted-foreground"
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </div>
  );
}

/** Atom: a small status pill (primary or muted tone). */
export function PreviewBadge({
  tone = "muted",
  children,
}: {
  tone?: "primary" | "muted";
  children: ReactNode;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs",
        tone === "primary"
          ? "bg-primary/15 text-primary"
          : "bg-muted text-muted-foreground"
      )}
    >
      {children}
    </span>
  );
}

/** Atom: a circular avatar seeded from the first character of a label. */
export function PreviewAvatar({
  label,
}: {
  label: string;
}): React.ReactElement {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 font-medium text-primary text-xs uppercase">
      {label.charAt(0)}
    </span>
  );
}

/** Layout atom: anchors a preview to the left and bleeds it off the right. */
export function BleedStage({
  children,
}: {
  children: ReactNode;
}): React.ReactElement {
  return (
    <div
      className="absolute top-1/2 left-14 w-[880px] -translate-y-1/2"
      style={{ maskImage: RIGHT_FADE, WebkitMaskImage: RIGHT_FADE }}
    >
      {children}
    </div>
  );
}

/** Layout atom: centers a fixed-width preview in the stage. */
export function CenteredStage({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
        className
      )}
    >
      {children}
    </div>
  );
}
