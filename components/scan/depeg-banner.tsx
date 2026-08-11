import { AlertTriangle } from "lucide-react";

type DepegBannerProps = {
  symbols: string[];
};

export function DepegBanner({
  symbols,
}: DepegBannerProps): React.ReactElement | null {
  if (symbols.length === 0) {
    return null;
  }

  return (
    <div
      className="mt-3 flex items-start gap-2 rounded-md border-l-4 border-[var(--color-border-error)] bg-[var(--color-bg-error)] px-4 py-3"
      role="alert"
    >
      <AlertTriangle
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-[var(--color-text-error)]"
      />
      <p className="text-sm font-medium text-[var(--color-text-error)]">
        Warning: {symbols.join(", ")} {symbols.length > 1 ? "are" : "is"}{" "}
        currently trading off {symbols.length > 1 ? "their" : "its"} $1.00 peg.
        Review positions before automating.
      </p>
    </div>
  );
}
