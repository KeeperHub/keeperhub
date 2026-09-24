/**
 * Strip credentials out of an RPC/WSS URL before it leaves the process.
 *
 * Chain-config carries the provider key in the URL *path*, not in a header or
 * query string - `wss://lb.drpc.live/solana-devnet/${DRPC_API_KEY}` is the
 * shape in production.json. `ConnectionHealth.activeEndpoint` is served on
 * `/healthz`, which any pod in the namespace can reach, so the raw value is a
 * live credential on an unauthenticated endpoint. Same class of defect as the
 * one already fixed in the EVM event-tracker.
 *
 * Ported from `event-tracker/src/chains/provider-manager.ts`, deliberately
 * keeping its behaviour identical so the two trackers redact the same way.
 *
 * The host is kept on purpose, and that is an assumption rather than a
 * guarantee: a provider that puts the token in the subdomain - QuickNode and
 * Chainstack both do - would survive this untouched. No configured Solana
 * upstream is of that shape today, and the host is what makes a failover
 * diagnosable, so it stays. Revisit when such an upstream is added.
 */
export function redactRpcUrl(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const hasMore = parsed.pathname !== "/" || parsed.search !== "";
    return `${parsed.protocol}//${parsed.host}${hasMore ? "/[redacted]" : ""}`;
  } catch {
    return "[redacted]";
  }
}

const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'`<>)\]]+/gi;

/**
 * Redact every URL embedded in free text, such as an error message.
 *
 * node-fetch 2 builds its failure message as `request to ${url} failed`, and
 * chain-config carries the provider key in the URL path, so a raw error
 * message is a credential. Use this on anything served as data, such as the
 * `lastError` field that `/healthz` returns.
 */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (url) => redactRpcUrl(url) ?? "[redacted]");
}
