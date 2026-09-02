import type { ComponentProps } from "react";

export function PythIcon(props: ComponentProps<"svg">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      role="img"
      aria-hidden="true"
      {...props}
    >
      <title>Pyth Network</title>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2L2 7.5v9L12 22l10-5.5v-9L12 2zm0 2.22l8 4.4v6.78l-8 4.4-8-4.4V8.62l8-4.401zM12 6.5l-5 2.75v5.5l5 2.75 5-2.75v-5.5L12 6.5zm0 2.22l3 1.65v3.3l-3 1.65-3-1.65v-3.3l3-1.65z"
      />
    </svg>
  );
}
