/**
 * The hosts and the webhook-URL rule that the Discord, Slack and Telegram
 * steps send to, in one place.
 *
 * They were defined inside the three step files and copied again into
 * `backup-channel.ts`, which sends to the same three. A copy is how a
 * tightened allowlist fixes the plugin and quietly leaves the fallback path on
 * the old rule, with nothing failing to signal it.
 *
 * It lives here rather than being exported from the step files because those
 * carry `"use step"`, and `plugins/CLAUDE.md` is explicit that exporting a
 * helper from one makes the workflow bundler pull its whole transitive
 * dependency graph into the runtime. This module imports nothing, so both a
 * step file and a lib module can read it.
 */

export const DISCORD_WEBHOOK_HOSTS: ReadonlySet<string> = new Set([
  "discord.com",
  "discordapp.com",
]);

export const SLACK_API_URL = "https://slack.com/api";
export const SLACK_POST_MESSAGE_URL = `${SLACK_API_URL}/chat.postMessage`;
export const TELEGRAM_API_HOST = "https://api.telegram.org";

export function telegramSendMessageUrl(botToken: string): string {
  return `${TELEGRAM_API_HOST}/bot${botToken}/sendMessage`;
}

/**
 * Whether a stored value is a Discord webhook this may post to.
 *
 * Matched by hostname over https, not by substring: a substring match on
 * "discord.com/api/webhooks/" is satisfied by an off-host URL carrying it in
 * the path (https://10.0.0.1/discord.com/api/webhooks/x), which points egress
 * at an internal host. safeFetch's SSRF guard is the network-layer backstop;
 * this rejects an off-host URL before any request is attempted.
 */
export function isValidDiscordWebhookUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    DISCORD_WEBHOOK_HOSTS.has(host) ||
    host.endsWith(".discord.com") ||
    host.endsWith(".discordapp.com");
  return allowed && parsed.pathname.startsWith("/api/webhooks/");
}
