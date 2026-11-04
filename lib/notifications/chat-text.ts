import { stripControlChars } from "@/lib/utils/control-chars";

// Chat text with outside text marked, so each provider gets it escaped and within its limit.

export type ChatChannel = "slack" | "discord" | "telegram";

/** Our own wording as a string; outside text (names, reasons) as `user`; error text as `code`. */
export type ChatPart = string | { user: string } | { code: string };
export type ChatText = readonly ChatPart[];

/** Discord's content limit, Telegram's text limit, and Slack's advised text size. */
export const CHAT_LIMITS: Readonly<Record<ChatChannel, number>> = {
  discord: 2000,
  slack: 4000,
  telegram: 4096,
};

type Format = ChatChannel | "plain";

const WHITESPACE = /\s+/g;
const BACKTICKS = /`/g;
const ANGLES_AND_AMP = /[&<>]/g;
const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
// Discord renders a backslash-escaped punctuation mark as itself.
const DISCORD_MARKDOWN = /[\\*_~`|[\]()<>#@]/g;
// Telegram links @name even in HTML mode; a word joiner after "@" stops it.
const TELEGRAM_MENTION = /@(?=\w)/g;
const WORD_JOINER = "\u2060";
const ELLIPSIS = "…";

/** One line, no control or bidi characters. */
function clean(text: string): string {
  return stripControlChars(text, { replacement: " " })
    .replace(WHITESPACE, " ")
    .trim();
}

/** Slack mrkdwn and Telegram HTML both need these three escaped. */
function escapeEntities(text: string): string {
  return text.replace(ANGLES_AND_AMP, (c) => ENTITIES[c] ?? c);
}

function formatOwn(text: string, format: Format): string {
  return format === "slack" || format === "telegram"
    ? escapeEntities(text)
    : text;
}

function formatUser(text: string, format: Format): string {
  const value = clean(text);
  if (format === "discord") {
    return value.replace(DISCORD_MARKDOWN, "\\$&");
  }
  if (format === "telegram") {
    return escapeEntities(value).replace(TELEGRAM_MENTION, `@${WORD_JOINER}`);
  }
  return formatOwn(value, format);
}

function formatCode(text: string, format: Format): string {
  const value = clean(text).replace(BACKTICKS, "'");
  if (!value || format === "plain") {
    return value;
  }
  if (format === "telegram") {
    return `<code>${escapeEntities(value)}</code>`;
  }
  return `\`${format === "slack" ? escapeEntities(value) : value}\``;
}

function formatPart(part: ChatPart, format: Format): string {
  if (typeof part === "string") {
    return formatOwn(part, format);
  }
  return "user" in part
    ? formatUser(part.user, format)
    : formatCode(part.code, format);
}

/** The text as one provider expects it; "plain" is the preview. */
export function formatChat(text: ChatText, format: Format): string {
  return text.map((part) => formatPart(part, format)).join("");
}

function withText(part: ChatPart, text: string): ChatPart {
  if (typeof part === "string") {
    return text;
  }
  return "user" in part ? { user: text } : { code: text };
}

function rawText(part: ChatPart): string {
  if (typeof part === "string") {
    return part;
  }
  return "user" in part ? part.user : part.code;
}

/** The longest start of a part whose formatted form fits in `room`. */
function shortenPart(part: ChatPart, format: Format, room: number): string {
  const runes = [...rawText(part)];
  let low = 0;
  let high = runes.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const piece = formatPart(
      withText(part, runes.slice(0, mid).join("")),
      format
    );
    if (piece.length <= room) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return formatPart(withText(part, runes.slice(0, low).join("")), format);
}

/** Last resort: cut at a part boundary, so no escape or tag is split. */
function cutToFit(text: ChatText, format: Format, limit: number): string {
  const room = limit - ELLIPSIS.length;
  let out = "";
  for (const part of text) {
    const piece = formatPart(part, format);
    if (out.length + piece.length > room) {
      return `${out}${shortenPart(part, format, room - out.length)}${ELLIPSIS}`;
    }
    out += piece;
  }
  return out;
}

/** The first variant (fullest first) that fits the provider's limit, else the last one cut. */
export function fitChat(
  variants: readonly ChatText[],
  channel: ChatChannel
): string {
  const limit = CHAT_LIMITS[channel];
  for (const variant of variants) {
    const formatted = formatChat(variant, channel);
    if (formatted.length <= limit) {
      return formatted;
    }
  }
  return cutToFit(variants.at(-1) ?? [], channel, limit);
}
