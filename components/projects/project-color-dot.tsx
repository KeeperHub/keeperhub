import type { Project } from "@/lib/api-client";

/** The small dot in a project's colour shown beside its name. */
export function ProjectColorDot({
  color,
}: {
  color: Project["color"];
}): React.ReactNode {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color ?? "var(--color-text-muted)" }}
    />
  );
}
