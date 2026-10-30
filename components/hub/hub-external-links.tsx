import { BookOpen, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HUB_FOCUS_RING } from "./hub-focus-ring";

// Demos + Docs links at the end of the hub tab band.
const LINKS = [
  { href: "https://youtube.com/@KeeperHub", label: "Demos", Icon: Play },
  { href: "https://docs.keeperhub.com", label: "Docs", Icon: BookOpen },
] as const;

// While the band is under 36rem the links grow to the search box's height.
const LINK_CLASSES = `${HUB_FOCUS_RING} text-xs transition-colors motion-reduce:transition-none @max-xl/hub-band:h-auto`;

// Below 375px the search box needs the room, so the links show their icons
// alone; the label stays as their accessible name.
const LABEL_CLASSES = "max-xs:sr-only";

export function HubExternalLinks(): React.ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-2 @max-xl/hub-band:items-stretch">
      {LINKS.map(({ href, label, Icon }) => (
        <Button
          asChild
          className={LINK_CLASSES}
          key={label}
          size="sm"
          variant="outline"
        >
          <a href={href} rel="noopener noreferrer" target="_blank">
            <Icon className="size-3.5" />
            <span className={LABEL_CLASSES}>{label}</span>
          </a>
        </Button>
      ))}
    </div>
  );
}
