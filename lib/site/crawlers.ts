/**
 * The AI agent crawlers and fetchers this deployment explicitly welcomes.
 *
 * Lives here rather than in app/robots.ts because two consumers need it: the
 * generated robots.txt, and the Cloudflare bot-management rule that has to
 * agree with it. A user-agent allowed in robots.txt but refused at the edge is
 * worse than either policy alone - the crawler is told it may fetch, gets a
 * 403, and its operator cannot tell a policy decision from an outage. A
 * readiness audit reads the same 403 as "this site is unreachable".
 *
 * This list is therefore not "every crawler we can name". It is exactly the set
 * the edge exempts on app.keeperhub.com, and the two must be changed together:
 *   techops-services/infrastructure, prod/keeperhub-infrastructure/cloudflare.tf
 *
 * Deliberately absent, because the edge blocks them everywhere and inviting
 * them here would recreate the contradiction above: Bytespider,
 * Meta-ExternalAgent, cohere-training-data-crawler, and every unnamed scraper.
 * Note that Meta-ExternalFetcher (user-initiated) is allowed while
 * Meta-ExternalAgent (bulk crawl) is not; they are different agents.
 */
export const AGENT_CRAWLER_USER_AGENTS: readonly string[] = [
  // Anthropic
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "Claude-Web",
  "Anthropic-AI",
  // OpenAI
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  // Perplexity
  "PerplexityBot",
  "Perplexity-User",
  "Perplexity-Search",
  // Google (Gemini / Vertex grounding)
  "Google-Extended",
  // Apple Intelligence
  "Applebot-Extended",
  // Mistral (Le Chat browsing)
  "MistralAI-User",
  // Meta, user-initiated fetches only
  "Meta-ExternalFetcher",
  // DeepSeek and Ora both already reach the origin; naming them keeps
  // robots.txt an accurate statement of policy rather than a partial one.
  "DeepSeekBot",
  "ora-agent",
];
