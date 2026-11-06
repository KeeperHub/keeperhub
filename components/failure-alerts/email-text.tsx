import { Fragment } from "react";
import { cn } from "@/lib/utils";

// Each half breaks inside itself only when it alone is wider than the space.
const HALF = "inline-block max-w-full align-bottom [overflow-wrap:anywhere]";

/** An email that wraps before "@", never at a hyphen, and is never cut off. */
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
    <span className={cn("min-w-0 break-normal", className)}>
      <span className={HALF} data-email-part="local">
        {email.slice(0, at)}
      </span>
      <wbr />
      <span className={HALF} data-email-part="domain">
        {email.slice(at)}
      </span>
    </span>
  );
}

const EMAIL = /[^\s(),;<>"']+@[^\s(),;<>"']+\.[^\s(),;<>"'.]+/g;

/** Running text with every email in it shown as an EmailText. */
export function TextWithEmails({ text }: { text: string }): React.ReactElement {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(EMAIL)) {
    const at = match.index ?? 0;
    parts.push(<Fragment key={`t${last}`}>{text.slice(last, at)}</Fragment>);
    parts.push(<EmailText email={match[0]} key={`e${at}`} />);
    last = at + match[0].length;
  }
  parts.push(<Fragment key={`t${last}`}>{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}
