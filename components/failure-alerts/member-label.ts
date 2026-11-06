import { truncateAddress } from "@/lib/address-utils";
import { isWalletEmail } from "@/lib/auth/wallet-constants";
import { actorLabel } from "@/lib/notifications/failure-alerts/actor-label";
import { requiredManagers } from "@/lib/notifications/failure-alerts/constants";
import { formatWhen } from "./format";

/** A wallet account's login is a synthetic address; show the wallet instead. */
export function memberLabel(m: {
  email: string | null;
  name: string | null;
  userId: string;
}): string {
  if (m.email && isWalletEmail(m.email)) {
    return truncateAddress(m.email.split("@")[0] ?? "");
  }
  return m.email ?? m.name ?? m.userId;
}

type Pickable = { userId: string; role: string; reachable: boolean };

/** Unticking this person would leave nobody, or no owner or admin who can get email. */
export function isLastRecipient(
  m: Pickable,
  chosen: string[],
  members: Pickable[]
): boolean {
  if (!chosen.includes(m.userId)) {
    return false;
  }
  if (chosen.length === 1) {
    return true;
  }
  const needed = requiredManagers(members, (x) => x.reachable);
  return (
    needed.some((x) => x.userId === m.userId) &&
    needed.filter((x) => chosen.includes(x.userId)).length === 1
  );
}

/** Whether any box in the picker is locked, so the note says why. */
export function recipientsLocked(
  chosen: string[],
  members: Pickable[]
): boolean {
  return members.some((m) => isLastRecipient(m, chosen, members));
}

export function lastRecipientNote(onlyOne: boolean): string {
  return onlyOne
    ? "Someone has to get the email. Tick another person first."
    : "An owner or admin who can get email must always get alerts. Tick another one first.";
}

// One "Name (account)" formatter for the page and the notices.
export {
  accountLabel,
  actorLabel,
} from "@/lib/notifications/failure-alerts/actor-label";

/** "Muted by Dana (dana@x.com) until Nov 13: reason", worded the same on every surface. */
export function muteSentence(m: {
  by: string | null;
  account: string | null;
  untilItWorks: boolean;
  mutedUntil: string | null;
  reason: string | null;
}): string {
  const who = actorLabel(m.by, m.account);
  const until = m.untilItWorks
    ? `until it works again${m.mutedUntil ? ` (at most until ${formatWhen(m.mutedUntil)})` : ""}`
    : `until ${formatWhen(m.mutedUntil ?? "")}`;
  return `Muted${who ? ` by ${who}` : ""} ${until}${m.reason ? `: ${m.reason}` : ""}`;
}
