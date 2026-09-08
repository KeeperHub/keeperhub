/**
 * AI agent crawlers this documentation site explicitly welcomes.
 *
 * Must stay identical to two other lists:
 *   - lib/site/crawlers.ts in the parent repo (the app's robots.txt)
 *   - rules 1 and 5 in prod/keeperhub-infrastructure/cloudflare.tf in the
 *     techops-services/infrastructure repo (what the edge actually permits)
 *
 * A UA invited here and refused at the edge is worse than either policy alone:
 * the crawler retries against a 403, and a readiness audit reads that 403 as
 * "this site is unreachable". tests/unit/docs-markdown.test.ts pins this list
 * against the app's so the copy cannot drift silently.
 *
 * The duplication is forced, not chosen - docs-site/Dockerfile copies only
 * `docs-site/` and `docs/`, so the parent `lib/` cannot be imported.
 */
export const AGENT_CRAWLER_USER_AGENTS: readonly string[] = [
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "Claude-Web",
  "Anthropic-AI",
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Perplexity-Search",
  "Google-Extended",
  "Applebot-Extended",
  "MistralAI-User",
  "Meta-ExternalFetcher",
  "DeepSeekBot",
  "ora-agent",
];
