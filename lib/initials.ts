const WHITESPACE = /\s+/;

// Splits text into what a reader sees as single characters, so a flag or an
// accented letter typed as two code points stays whole.
const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function firstCharacter(word: string): string {
  if (segmenter) {
    for (const { segment } of segmenter.segment(word)) {
      return segment;
    }
    return "";
  }
  return Array.from(word)[0] ?? "";
}

// Upper case, unless that makes more than one character ("ß" to "SS").
function upper(character: string): string {
  const upperCased = character.toUpperCase();
  return firstCharacter(upperCased) === upperCased ? upperCased : character;
}

/**
 * A name's initials, wherever the app shows them (an organization, a user,
 * an actor): the first character of its first two words ("Acme Labs" ->
 * "AL", "Personal" -> "P"), "?" when there is none.
 */
export function getInitials(name: string): string {
  const words = name.trim().split(WHITESPACE).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => upper(firstCharacter(word)))
    .join("");
  return initials || "?";
}

/**
 * A person's initials, wherever the app shows them (the user menu, an
 * activity's actor): their name's, else the first character of their
 * email, "?" with neither.
 */
export function getPersonInitials(
  person: { name?: string | null; email?: string | null } | null | undefined
): string {
  const name = person?.name?.trim();
  if (name) {
    return getInitials(name);
  }
  const email = person?.email?.trim();
  return email ? upper(firstCharacter(email)) : "?";
}

/**
 * The organization switcher's spoken name, before "switch organization": the
 * name, then the initials when the name has more than one word ("Acme Labs
 * (AL)"). The button shows one or the other, so voice control can match
 * either; a one-word name's initial is its own first letter ("Personal").
 */
export function getOrganizationLabel(name: string): string {
  const trimmed = name.trim();
  const initials = getInitials(trimmed);
  const words = trimmed.split(WHITESPACE).filter(Boolean);
  if (words.length <= 1) {
    return trimmed || initials;
  }
  return `${trimmed} (${initials})`;
}
