import { SUGGESTION_DISCLAIMER } from "@/lib/scan/suggestions/types";

export function ScanDisclaimer(): React.ReactElement {
  return (
    <p className="mt-6 border-t border-border/30 pt-4 text-xs leading-relaxed text-muted-foreground">
      {SUGGESTION_DISCLAIMER}
    </p>
  );
}
