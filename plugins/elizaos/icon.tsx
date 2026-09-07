import type React from "react";

export function ElizaOSIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      aria-label="ElizaOS"
      className={className}
      fill="none"
      role="img"
      style={style}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>ElizaOS</title>
      <rect width="20" height="20" x="2" y="2" rx="4" fill="#FF5E00" />
      <path
        d="M7 8h10M7 12h7M7 16h10"
        stroke="#FFFFFF"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="12" r="1.2" fill="#FFFFFF" />
    </svg>
  );
}
