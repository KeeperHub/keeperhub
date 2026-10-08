export function PredgeIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      aria-label="Predge"
      className={className}
      fill="none"
      role="img"
      style={style}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Predge</title>
      <path
        d="M12 2 4 5.5v6c0 4.6 3.2 8.4 8 10.5 4.8-2.1 8-5.9 8-10.5v-6L12 2Z"
        fill="#f5a623"
      />
      <path
        d="m8.5 12 2.4 2.4L15.8 9.5"
        stroke="#0b0f14"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}
