import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import {
  isLooseLegacyFlag,
  SEND_MODE,
  type SendMode,
  type SendModeChain,
  sendModeOn,
} from "@/lib/web3/send-mode";

/** A chain as /api/chains lists it, for the Send as rules. */
export type EditorChain = SendModeChain & {
  chainId: number | string;
  name?: string;
};

// The editor's chain list, shared by every Send as reader in the tab.
let editorChains: readonly EditorChain[] | undefined;
const chainListeners = new Set<() => void>();

export function setEditorSendModeChains(
  rows: readonly EditorChain[] | undefined
): void {
  editorChains = rows;
  for (const listener of chainListeners) {
    listener();
  }
}

export function getEditorSendModeChains(): readonly EditorChain[] | undefined {
  return editorChains;
}

export function subscribeEditorSendModeChains(
  listener: () => void
): () => void {
  chainListeners.add(listener);
  return () => {
    chainListeners.delete(listener);
  };
}

/** The chain a network value names (an id or an old name like "base"), once known. */
export function editorChainOf(network: unknown): EditorChain | undefined {
  if (
    !editorChains ||
    (typeof network !== "string" && typeof network !== "number")
  ) {
    return;
  }
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch {
    return;
  }
  return editorChains.find((row) => Number(row.chainId) === chainId);
}

/**
 * Send as as the editor shows it, the same as the step runs it. An old
 * non-boolean flag stays Normal until its chain is known.
 */
export function editorSendModeOn(
  config: Record<string, unknown>,
  networkField: string
): SendMode {
  const chain = editorChainOf(config[networkField]);
  return chain === undefined && isLooseLegacyFlag(config)
    ? SEND_MODE.TRANSACTION
    : sendModeOn(config, chain);
}
