type ReadWritePillProps = {
  value: "read" | "write";
};

export function ReadWritePill({
  value,
}: ReadWritePillProps): React.ReactElement {
  const className =
    value === "write"
      ? "bg-[var(--color-bg-accent)] text-[var(--color-text-accent)] text-[0.625rem] font-medium rounded-full px-2 py-0.5"
      : "bg-muted text-muted-foreground text-[0.625rem] font-medium rounded-full px-2 py-0.5";

  return (
    <span className={className}>
      {value === "write" ? "write" : "read-only"}
    </span>
  );
}
