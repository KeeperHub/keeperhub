/**
 * PagerDuty's mark, as published in Simple Icons, whose icon files are
 * released under CC0 1.0 Universal (public domain dedication). The PagerDuty
 * name and logo remain PagerDuty's trademarks; this use identifies the service
 * the plugin integrates with, which is what the mark is for.
 *
 * Source: https://github.com/simple-icons/simple-icons (icons/pagerduty.svg)
 */
export function PagerDutyIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      className={className}
      fill="#06AC38"
      role="img"
      style={style}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>PagerDuty</title>
      <path d="M16.965 1.18C15.085.164 13.769 0 10.683 0H3.73v14.55h6.926c2.743 0 4.8-.164 6.61-1.37 1.975-1.303 3.004-3.484 3.004-6.007 0-2.716-1.262-4.896-3.305-5.994zm-5.5 10.326h-4.21V3.113l3.977-.027c3.62-.028 5.43 1.234 5.43 4.128 0 3.113-2.248 4.292-5.197 4.292zM3.73 17.61h3.525V24H3.73Z" />
    </svg>
  );
}
