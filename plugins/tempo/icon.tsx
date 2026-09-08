export function TempoIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      className={className}
      fill="none"
      height="148"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.25"
      style={style}
      viewBox="0 0 24 24"
      width="148"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Tempo</title>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
