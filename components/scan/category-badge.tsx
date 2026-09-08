import type { SuggestionCategory } from "@/lib/scan/suggestions/types";

const CATEGORY_LABELS: Record<SuggestionCategory, string> = {
  health: "Health",
  yield: "Yield",
  alert: "Alert",
  claim: "Claim",
};

// All categories share one quiet outline treatment so category tags do not
// compete with the card title.
const BADGE_CLASS =
  "inline-flex items-center rounded-full border border-border bg-transparent px-2 py-0.5 font-medium text-[0.625rem] text-muted-foreground";

type CategoryBadgeProps = {
  category: SuggestionCategory;
};

export function CategoryBadge({
  category,
}: CategoryBadgeProps): React.ReactElement {
  return (
    <span
      aria-label={`Category: ${category}`}
      className={BADGE_CLASS}
      role="img"
    >
      {CATEGORY_LABELS[category]}
    </span>
  );
}
