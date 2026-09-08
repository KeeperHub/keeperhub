export function MathIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-label="Math logo"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Math</title>
      {/* Sigma symbol - standard math aggregation icon */}
      <path d="M18 4H6l6 8-6 8h12" />
    </svg>
  );
}
