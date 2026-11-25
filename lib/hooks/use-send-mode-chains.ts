"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  readCachedResource,
  writeCachedResource,
} from "@/lib/hooks/use-cached-resource";
import {
  type EditorChain,
  getEditorSendModeChains,
  setEditorSendModeChains,
  subscribeEditorSendModeChains,
} from "@/lib/workflow/editor/send-mode-chains";

const CHAINS_KEY = "/api/chains";
const RETRY_DELAYS_MS = [1000, 3000, 10_000];

let chainsRequest: Promise<void> | undefined;

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
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function serverChains(): undefined {
  return;
}

/** The chains /api/chains lists, loaded once per tab for every Send as reader. */
export function useSendModeChains(): readonly EditorChain[] | undefined {
  const rows = useSyncExternalStore(
    subscribeEditorSendModeChains,
    getEditorSendModeChains,
    serverChains
  );
  useEffect(() => {
    if (getEditorSendModeChains() || chainsRequest) {
      return;
    }
    chainsRequest = loadChains()
      .catch((error: unknown) => {
        console.error("[SendModeChains] Failed to load chains", error);
      })
      .finally(() => {
        // A later mount tries again if this one gave up.
        chainsRequest = undefined;
      });
  }, []);
  return rows;
}
