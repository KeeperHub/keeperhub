// Which of a chain's two configured RPC endpoints a value refers to.
export const RPC_ENDPOINT = {
  PRIMARY: "primary",
  FALLBACK: "fallback",
} as const;

export type RpcEndpoint = (typeof RPC_ENDPOINT)[keyof typeof RPC_ENDPOINT];
