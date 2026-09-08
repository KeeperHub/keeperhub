/**
 * Request-body types and heuristic gas constants shared by the Safe role
 * routes (simulate-deploy, [safeId]/role/simulate, [safeId]/role/update).
 * The two simulate routes deliberately accept different top-level envelopes
 * (SimulateBody stays per-route); only the common pieces live here.
 */

export type TokenLimitBody = {
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  amountHuman?: string;
  periodSeconds?: number;
};

export type DirectRuleBody = {
  kind?: "erc20-transfer" | "erc20-approve" | "native-transfer";
  tokenAddress?: string | null;
  tokenSymbol?: string;
  tokenDecimals?: number;
  counterparty?: string;
  amountHuman?: string;
  periodSeconds?: number;
};

export type OperationSummary = {
  label: string;
  detail: string;
  gasUnits: string;
};

export const GAS_DEPLOY_MODULE = BigInt(350_000);
export const GAS_ENABLE_MODULE = BigInt(55_000);
export const GAS_ASSIGN_ROLES = BigInt(80_000);
export const GAS_SET_DEFAULT_ROLE = BigInt(45_000);
export const GAS_SCOPE_TARGET = BigInt(60_000);
export const GAS_SCOPE_FUNCTION = BigInt(70_000);
export const GAS_SET_ALLOWANCE = BigInt(75_000);
export const GAS_OUTER_WRAPPER = BigInt(50_000);
