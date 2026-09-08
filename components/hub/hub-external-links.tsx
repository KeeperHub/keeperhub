import { BookOpen, Play } from "lucide-react";

// Demos + Docs anchor cluster. Originally rendered inside HubHero on the
// right edge of the headline row; lifted into the tab-strip band so the
// hero can stretch to full width and the anchors share a baseline with
// the tab pills.
export function HubExternalLinks(): React.ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <a
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-hub-icon-bg)] px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:border-border/60 hover:text-foreground motion-reduce:transition-none"
        href="https://youtube.com/@KeeperHub"
        rel="noopener noreferrer"
        target="_blank"
      >
        <Play className="size-3" />
        Demos
      </a>
      <a
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-hub-icon-bg)] px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:border-border/60 hover:text-foreground motion-reduce:transition-none"
        href="https://docs.keeperhub.com"
        rel="noopener noreferrer"
        target="_blank"
      >
        <BookOpen className="size-3" />
        Docs
      </a>
    </div>
  );
}
