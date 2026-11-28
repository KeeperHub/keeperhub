import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import {
  isLegacyPrivateRelayConfig,
  resolveSendMode,
  SEND_MODE,
  type SendMode,
  type SendModeChain,
} from "@/lib/web3/send-mode";

/** A chain as /api/chains lists it, for the Send as rules. */
export type EditorChain = SendModeChain & {
  chainId: number | string;
  name?: string;
  // The network's tip limit in gwei, as /api/chains gives it.
  tipLimitGwei?: number | null;
};

// The editor's chain list, shared by every Send as reader in the tab.
let editorChains: readonly EditorChain[] | undefined;
// Every load attempt failed; cleared when a later load starts.
let editorChainsFailed = false;
// Whether the organization may send bundles; undefined until known.
let editorBundlesEnabled: boolean | undefined;
const chainListeners = new Set<() => void>();

function notifyChainListeners(): void {
  for (const listener of chainListeners) {
    listener();
  }
}

export function setEditorSendModeChains(
  rows: readonly EditorChain[] | undefined
): void {
  editorChains = rows;
  notifyChainListeners();
}

export function getEditorSendModeChains(): readonly EditorChain[] | undefined {
  return editorChains;
}

export function setEditorSendModeChainsFailed(failed: boolean): void {
  editorChainsFailed = failed;
  notifyChainListeners();
}

export function getEditorSendModeChainsFailed(): boolean {
  return editorChainsFailed;
}

export function setEditorBundlesEnabled(enabled: boolean | undefined): void {
  if (editorBundlesEnabled !== enabled) {
    editorBundlesEnabled = enabled;
    notifyChainListeners();
  }
}

export function getEditorBundlesEnabled(): boolean | undefined {
  return editorBundlesEnabled;
}

/** The chain list is still loading: neither listed nor failed. */
function chainListLoading(): boolean {
  return editorChains === undefined && !editorChainsFailed;
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
  const row = editorChains.find((entry) => Number(entry.chainId) === chainId);
  return row && { ...row, bundlesEnabled: editorBundlesEnabled };
}

/**
 * Send as as the editor shows it. An old "(Flashbots)" flag shows as Normal only
 * while the chain list loads; after that it shows as Private relay, also on a
 * network the list does not resolve (a template), with a notice.
 */
export function editorSendModeOn(
  config: Record<string, unknown>,
  networkField: string
): SendMode {
  return isLegacyPrivateRelayConfig(config) &&
    chainListLoading() &&
    editorChainOf(config[networkField]) === undefined
    ? SEND_MODE.TRANSACTION
    : resolveSendMode(config);
}
