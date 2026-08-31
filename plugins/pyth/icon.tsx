import type { ComponentProps } from "react";

export function PythIcon(props: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 2L2 7.5v9L12 22l10-5.5v-9L12 2zM4 8.61l8-4.4 8 4.4v6.78l-8 4.4-8-4.4V8.61z" />
      <path d="M12 6.5l-5 2.75v5.5l5 2.75 5-2.75v-5.5L12 6.5zm3 7.15l-3 1.65-3-1.65v-3.3l3-1.65 3 1.65v3.3z" />
    </svg>
  );
}
