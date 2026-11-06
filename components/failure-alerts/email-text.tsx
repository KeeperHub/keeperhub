import { Fragment } from "react";
import { cn } from "@/lib/utils";

// Each half breaks inside itself only when it alone is wider than the space.
const HALF = "inline-block max-w-full align-bottom [overflow-wrap:anywhere]";

/** An email that wraps before "@", never at a hyphen, and is never cut off. */
export function EmailText({
  email,
  className,
  before = "",
  after = "",
}: {
  email: string;
  className?: string;
  /** Punctuation kept on the email's first line, e.g. "(". */
  before?: string;
  /** Punctuation kept on its last line, e.g. ").". */
  after?: string;
}): React.ReactElement {
  const at = email.lastIndexOf("@");
  if (at <= 0) {
    return (
      <span className={cn("break-words", className)}>
        {before}
        {email}
        {after}
      </span>
    );
  }
  return (
    <span className={cn("min-w-0 break-normal", className)}>
      <span className={HALF} data-email-part="local">
        {before}
        {email.slice(0, at)}
      </span>
      <wbr />
      <span className={HALF} data-email-part="domain">
        {email.slice(at)}
        {after}
      </span>
    </span>
  );
}

// An email (no nested repeats, so no backtracking), with an opening bracket just before it.
const EMAIL = /(\(?)([^\s(),;<>"'@]+@[^\s(),;<>"'@]+)(\)?)/g;
const TRAILING_PUNCTUATION = /[.,:;]+$/;
const WHITESPACE = /\s/;

/** Running text with every email in it shown as an EmailText, its brackets kept beside it. */
export function TextWithEmails({ text }: { text: string }): React.ReactElement {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(EMAIL)) {
    const at = match.index ?? 0;
    parts.push(<Fragment key={`t${last}`}>{text.slice(last, at)}</Fragment>);
    // A sentence's full stop after the address stays with it, outside the address.
    const tail = TRAILING_PUNCTUATION.exec(match[2])?.[0] ?? "";
    const email = match[2].slice(0, match[2].length - tail.length);
    let after = `${tail}${match[3]}`;
    let end = at + match[0].length;
    const next = TRAILING_PUNCTUATION.exec(
      text.slice(end).split(WHITESPACE)[0] ?? ""
    );
    if (match[3] && next && next.index === 0) {
      after += next[0];
      end += next[0].length;
    }
    parts.push(
      <EmailText after={after} before={match[1]} email={email} key={`e${at}`} />
    );
    last = end;
  }
  parts.push(<Fragment key={`t${last}`}>{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}
