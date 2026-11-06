import { cn } from "@/lib/utils";

/** An email that may wrap only before "@"; each half is cut with "…" only if it alone is too wide. */
export function EmailText({
  email,
  className,
}: {
  email: string;
  className?: string;
}): React.ReactElement {
  const at = email.lastIndexOf("@");
  if (at <= 0) {
    return <span className={cn("break-words", className)}>{email}</span>;
  }
  return (
    <span className={cn("min-w-0 break-normal", className)} title={email}>
      <span
        className="inline-block max-w-full truncate align-bottom"
        data-email-part="local"
      >
        {email.slice(0, at)}
      </span>
      <wbr />
      <span
        className="inline-block max-w-full truncate align-bottom"
        data-email-part="domain"
      >
        {email.slice(at)}
      </span>
    </span>
  );
}
