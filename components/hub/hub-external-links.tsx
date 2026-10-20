import { BookOpen, Play } from "lucide-react";

// Demos + Docs anchor cluster. Originally rendered inside HubHero on the
// right edge of the headline row; lifted into the tab-strip band so the
// hero can stretch to full width and the anchors share a baseline with
// the tab pills.
const LINK_CLASSES =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-[var(--color-hub-icon-bg)] px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:border-border/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-accent)] motion-reduce:transition-none";

// Below 375px the search box needs the room, so the links show their icons
// alone; the label stays as their accessible name.
const LABEL_CLASSES = "max-xs:sr-only";

export function HubExternalLinks(): React.ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-2 max-sm:items-stretch">
      <a
        className={LINK_CLASSES}
        href="https://youtube.com/@KeeperHub"
        rel="noopener noreferrer"
        target="_blank"
      >
        <Play className="size-3" />
        <span className={LABEL_CLASSES}>Demos</span>
      </a>
      <a
        className={LINK_CLASSES}
        href="https://docs.keeperhub.com"
        rel="noopener noreferrer"
        target="_blank"
      >
        <BookOpen className="size-3" />
        <span className={LABEL_CLASSES}>Docs</span>
      </a>
    </div>
  );
}
