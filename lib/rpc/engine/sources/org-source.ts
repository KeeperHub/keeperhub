import type { OrgRpcState } from "../types";

/** An organization's RPC configs and policy for one chain. */
export type OrgRpcSource = {
  load(organizationId: string, chainId: number): Promise<OrgRpcState>;
};

export const EMPTY_ORG_RPC_STATE: OrgRpcState = {
  policy: { ownRpcOnly: false },
  configs: [],
};

/** Used until organizations can store their own endpoints. */
export const emptyOrgRpcSource: OrgRpcSource = {
  load: (): Promise<OrgRpcState> => Promise.resolve(EMPTY_ORG_RPC_STATE),
};
