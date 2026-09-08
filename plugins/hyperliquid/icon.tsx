export function HyperliquidIcon({
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
      role="img"
      style={style}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Hyperliquid</title>
      <path
        d="M11.5 11C9.5 9.5 8 6.5 6.5 6C5 5.5 3 7.5 3 11C3 14.5 5 16.5 6.5 16.5C8 16.5 9.5 14.5 11.5 13C13.5 15 14.5 20.5 16 20.5C19 20.5 22 17 22 12C22 7 19 3.5 16 3.5C14.5 3.5 13.5 9 11.5 11Z"
        fill="#97FCE4"
      />
    </svg>
  );
}
