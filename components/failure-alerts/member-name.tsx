import { EmailText } from "./email-text";
import { memberLabel } from "./member-label";

/** A person in a picker: their name, then their email (or wallet) below, never split mid-word. */
export function MemberName({
  member,
}: {
  member: { email: string | null; name: string | null; userId: string };
}): React.ReactElement {
  const account = memberLabel(member);
  const name = member.name?.trim();
  if (!name || name === account) {
    return <EmailText className="block" email={account} />;
  }
  return (
    <span className="block min-w-0">
      <span className="line-clamp-2 block break-words">{name}</span>
      <EmailText
        className="block text-muted-foreground text-xs"
        email={account}
      />
    </span>
  );
}
