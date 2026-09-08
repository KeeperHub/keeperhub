"use client";

export function UsageMeter({
  label,
  used,
  total,
  format,
  hint,
}: {
  label: string;
  used: number;
  total: number;
  format: (value: number) => string;
  hint?: string;
}): React.ReactElement {
  const unlimited = !Number.isFinite(total) || total <= 0;
  const pct = unlimited ? 0 : Math.min(100, (used / total) * 100);
  const nearLimit = pct >= 80;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm">{label}</span>
        <span className="font-mono text-xs">
          {format(used)}
          <span className="text-muted-foreground">
            {" / "}
            {unlimited ? "Unlimited" : format(total)}
          </span>
        </span>
      </div>
      {!unlimited && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={
              nearLimit
                ? "h-full rounded-full bg-amber-400"
                : "h-full rounded-full bg-foreground/70"
            }
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}
