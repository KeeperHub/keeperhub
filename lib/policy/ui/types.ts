/**
 * Shapes the policy UI reads.
 *
 * Declared here rather than in a component so every picker, hook and context
 * agrees on one definition. A list of options is domain data, not a rendering
 * detail: two components building the same list from the same catalog is how
 * they drift apart.
 */

export type PolicyOption = {
  value: string;
  label: string;
  /** Shown under the label and searched alongside it. */
  hint?: string;
  /** Options sharing a group render under one heading. */
  group?: string;
};

export type CatalogChain = {
  chainId: number;
  name: string;
  isTestnet: boolean;
  /** The chain's native currency, e.g. ETH, AVAX, BNB. */
  symbol: string | null;
};

export type CatalogToken = {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number | null;
  isStablecoin: boolean;
  /** True when the organization added it rather than the platform tracking it. */
  custom: boolean;
};

export type CatalogDeployment = {
  chainId: number;
  address: string;
  resource: string;
};

export type CatalogProtocol = {
  slug: string;
  name: string;
  contracts: {
    key: string;
    label: string;
    deployments: CatalogDeployment[];
  }[];
  actions: { slug: string; label: string; type: string }[];
};

export type CatalogMember = {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
};

export type CatalogNamed = { id: string; name: string };

export type CatalogWallet = { id: string; address: string; chainId: number };

export type CatalogCounterparty = { label: string; address: string };

export type CatalogCapability = {
  id: string;
  label: string;
  valueMoving: boolean;
  guardDimensions: string[];
};

/** Everything a policy can be written against, served as one document. */
export type PolicyCatalog = {
  capabilities: { data: CatalogCapability[]; control: CatalogCapability[] };
  chains: CatalogChain[];
  protocols: CatalogProtocol[];
  counterparties: CatalogCounterparty[];
  tokens: CatalogToken[];
  projects: CatalogNamed[];
  tags: CatalogNamed[];
  members: CatalogMember[];
  workflows: CatalogNamed[];
  wallets: CatalogWallet[];
};

export const EMPTY_POLICY_CATALOG: PolicyCatalog = {
  capabilities: { data: [], control: [] },
  chains: [],
  protocols: [],
  counterparties: [],
  tokens: [],
  projects: [],
  tags: [],
  members: [],
  workflows: [],
  wallets: [],
};
