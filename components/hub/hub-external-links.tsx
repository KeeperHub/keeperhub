import { BookOpen, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

// Demos + Docs anchor cluster. Originally rendered inside HubHero on the
// right edge of the headline row; lifted into the tab-strip band so the
// hero can stretch to full width and the anchors share a baseline with
// the tab pills.

// On phones the links grow to the search box's height.
const LINK_CLASSES = "text-xs @max-xl/hub-band:h-auto";

// Below 375px the search box needs the room, so the links show their icons
// alone; the label stays as their accessible name.
const LABEL_CLASSES = "max-xs:sr-only";

export function HubExternalLinks(): React.ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-2 @max-xl/hub-band:items-stretch">
      <Button asChild className={LINK_CLASSES} size="sm" variant="outline">
        <a
          href="https://youtube.com/@KeeperHub"
          rel="noopener noreferrer"
          target="_blank"
        >
          <Play className="size-3.5" />
          <span className={LABEL_CLASSES}>Demos</span>
        </a>
      </Button>
      <Button asChild className={LINK_CLASSES} size="sm" variant="outline">
        <a
          href="https://docs.keeperhub.com"
          rel="noopener noreferrer"
          target="_blank"
        >
          <BookOpen className="size-3.5" />
          <span className={LABEL_CLASSES}>Docs</span>
        </a>
      </Button>
    </div>
  );
}
