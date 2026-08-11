import { Skeleton } from "@/components/ui/skeleton";

export function SuggestionCardSkeleton(): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className="relative flex min-h-[160px] flex-col rounded-xl border border-border/20 bg-[var(--color-hub-card)] p-4"
    >
      <Skeleton className="mb-3 h-4 w-16 rounded-full motion-reduce:animate-none" />
      <Skeleton className="mb-2 h-4 w-3/4 motion-reduce:animate-none" />
      <Skeleton className="mb-1 h-3 w-full motion-reduce:animate-none" />
      <Skeleton className="mb-1 h-3 w-5/6 motion-reduce:animate-none" />
      <div className="mt-auto flex items-center gap-3 pt-3">
        <Skeleton className="h-3 w-16 motion-reduce:animate-none" />
        <Skeleton className="h-4 w-12 rounded-full motion-reduce:animate-none" />
      </div>
    </div>
  );
}
