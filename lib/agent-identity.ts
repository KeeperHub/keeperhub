/**
 * Who this deployment says it is.
 *
 * The `.well-known` routes publish an identity to agent registries, reputation
 * scorers and OAuth clients. Every value was hardcoded, so a deployment run by
 * someone else announced itself as KeeperHub - and, worse than a wrong name,
 * republished KeeperHub's registered on-chain agent, pointing third-party
 * scorers at the wrong host.
 *
 * Every default below is the value that was hardcoded before, so a deployment
 * that configures nothing produces byte-identical output.
 *
 * Server-only on purpose. A NEXT_PUBLIC_ variable is inlined at build time, and
 * a deployment running a prebuilt image could not change it without rebuilding.
 */

const TRAILING_SLASH = /\/$/;

export const DEFAULT_AGENT_NAME = "KeeperHub";

/** KeeperHub's own ERC-8004 registration. See the coherence guard below. */
const DEFAULT_AGENT_ID = 31_875;
const DEFAULT_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const DEFAULT_REGISTRY_CHAIN = "ethereum";
const DEFAULT_REGISTRY_CHAIN_ID = 1;

export type OnChainAgentIdentity = {
  agentId: number;
  chain: string;
  chainId: number;
  registry: string;
};

export type AgentIdentity = {
  name: string;
  /** Present only when it can be published truthfully. See onChainIdentity(). */
  onChain: OnChainAgentIdentity | null;
};

/**
 * The origin this deployment is reached on.
 *
 * Lifted from the four `.well-known` routes that each carried an identical
 * copy. Falls back to the request host so a deployment that sets neither
 * variable still advertises something reachable rather than a KeeperHub URL.
 */
export function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function agentName(): string {
  return process.env.AGENT_NAME?.trim() || DEFAULT_AGENT_NAME;
}

export function agentDescription(fallback: string): string {
  return process.env.AGENT_DESCRIPTION?.trim() || fallback;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The on-chain agent registration, or null when there is nothing truthful to
 * publish.
 *
 * The coherence guard is the point of this function. An operator who renames
 * the agent has declared "this is not KeeperHub", and an install in that state
 * has nothing true to say about KeeperHub's registration - but leaving the
 * default in place would publish exactly that: a plausible-looking card
 * carrying our agent id under their name, which is worse than publishing
 * nothing because a reputation scorer would believe it.
 *
 * So the registration is published only when it is internally consistent:
 * either nothing is customised (KeeperHub's own deployment), or the operator
 * supplied their own agent id to go with their own name.
 */
export function onChainIdentity(): OnChainAgentIdentity | null {
  const configuredId = parsePositiveInt(process.env.AGENT_ID);
  const renamed = agentName() !== DEFAULT_AGENT_NAME;

  if (renamed && configuredId === null) {
    return null;
  }

  return {
    agentId: configuredId ?? DEFAULT_AGENT_ID,
    chain: process.env.AGENT_REGISTRY_CHAIN?.trim() || DEFAULT_REGISTRY_CHAIN,
    chainId:
      parsePositiveInt(process.env.AGENT_REGISTRY_CHAIN_ID) ??
      DEFAULT_REGISTRY_CHAIN_ID,
    registry: process.env.AGENT_REGISTRY_ADDRESS?.trim() || DEFAULT_REGISTRY,
  };
}

export function agentIdentity(): AgentIdentity {
  return { name: agentName(), onChain: onChainIdentity() };
}
