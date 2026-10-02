import type { SVGProps } from "react";

export function AgentGatewayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <title>Agent Gateway</title>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
      <path d="M12 6v2" />
      <path d="M12 16v2" />
    </svg>
  );
}

export default AgentGatewayIcon;
