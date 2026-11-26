"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  readCachedResource,
  writeCachedResource,
} from "@/lib/hooks/use-cached-resource";
import { sleep } from "@/lib/sleep";
import {
  type EditorChain,
  getEditorSendModeChains,
  getEditorSendModeChainsFailed,
  setEditorSendModeChains,
  setEditorSendModeChainsFailed,
  subscribeEditorSendModeChains,
} from "@/lib/workflow/editor/send-mode-chains";

const CHAINS_KEY = "/api/chains";
const RETRY_DELAYS_MS = [1000, 3000, 10_000];

let chainsRequest: Promise<void> | undefined;
// Retry unmounts itself while the list loads: this control keeps focus meanwhile.
let retryFocusId: string | undefined;

/** Focuses the retry's control once its state renders, unless focus moved on. */
function keepRetryFocus(): void {
  const id = retryFocusId;
  if (!id) {
    return;
  }
  setTimeout(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active.id === id) {
      document.getElementById(id)?.focus();
    }
    if (!chainsRequest) {
      retryFocusId = undefined;
    }
  }, 0);
}

async function loadChains(): Promise<void> {
  const cached = readCachedResource<EditorChain[]>(CHAINS_KEY);
  if (cached) {
    setEditorSendModeChains(cached);
    return;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(CHAINS_KEY);
      if (!response.ok) {
        throw new Error(`/api/chains answered ${response.status}`);
      }
      const rows = (await response.json()) as EditorChain[];
      writeCachedResource(CHAINS_KEY, rows);
      setEditorSendModeChains(rows);
      return;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        throw error;
      }
      await sleep(delay);
    }
  }
}

/** Loads the chain list unless it is known or loading; a failed load can be retried. */
function requestChains(): void {
  if (getEditorSendModeChains() || chainsRequest) {
    return;
  }
  setEditorSendModeChainsFailed(false);
  chainsRequest = loadChains()
    .catch((error: unknown) => {
      console.error("[SendModeChains] Failed to load chains", error);
      setEditorSendModeChainsFailed(true);
    })
    .finally(() => {
      chainsRequest = undefined;
      keepRetryFocus();
    });
}

/** Loads the list again; `focusId` names the field that keeps focus meanwhile. */
function retryChains(focusId: string): void {
  retryFocusId = focusId;
  requestChains();
  keepRetryFocus();
}

function serverChains(): undefined {
  return;
}

function serverFailed(): boolean {
  return false;
}

type SendModeChainsState = {
  chains: readonly EditorChain[] | undefined;
  /** Every retry failed; `retry` loads again. */
  failed: boolean;
  retry: (focusId: string) => void;
};

/** The chains /api/chains lists, loaded once per tab for every network and Send as reader. */
export function useSendModeChains(): SendModeChainsState {
  const chains = useSyncExternalStore(
    subscribeEditorSendModeChains,
    getEditorSendModeChains,
    serverChains
  );
  const failed = useSyncExternalStore(
    subscribeEditorSendModeChains,
    getEditorSendModeChainsFailed,
    serverFailed
  );
  // A later mount tries again if an earlier one gave up.
  useEffect(requestChains, []);
  return { chains, failed, retry: retryChains };
}
