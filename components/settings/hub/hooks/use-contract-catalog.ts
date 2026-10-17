"use client";

import { useCallback, useState } from "react";
import type { SelectorCatalogEntry } from "@/lib/policy/catalog/types";
import { useSettingsContext } from "../settings-context";

export type ContractRiskGroup = {
  riskClass: string;
  label: string;
  entries: SelectorCatalogEntry[];
};

export type ContractCatalogResponse = {
  chainId: number;
  address: string;
  implementationAddress: string | null;
  isProxy: boolean;
  /** False when the contract has no published ABI. Not an error. */
  verified: boolean;
  collisions: string[];
  dispatchers: string[];
  ambientConditionKeys: string[];
  groups: ContractRiskGroup[];
  readCount: number;
};

export type ContractCatalogState = {
  catalog: ContractCatalogResponse | null;
  loading: boolean;
  error: string | null;
  load: (chainId: number, address: string, protocolSlug?: string) => void;
  reset: () => void;
};

/**
 * Fetch the selector catalog for one contract.
 *
 * An unverified contract resolves rather than failing: the response comes back
 * with `verified: false` and no functions, which the picker renders as a plain
 * selector field. Authoring must never be blocked by a contract we cannot
 * describe.
 */
export function useContractCatalog(): ContractCatalogState {
  const { organizationId } = useSettingsContext();
  const [catalog, setCatalog] = useState<ContractCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (chainId: number, address: string, protocolSlug?: string) => {
      if (!organizationId) {
        return;
      }
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({
        chainId: String(chainId),
        address,
      });
      if (protocolSlug) {
        params.set("protocolSlug", protocolSlug);
      }

      fetch(
        `/api/organizations/${organizationId}/policies/catalog/contract?${params}`
      )
        .then(async (res) => {
          const body = (await res.json()) as ContractCatalogResponse & {
            error?: string;
          };
          if (!res.ok) {
            throw new Error(body.error ?? "Could not read the contract");
          }
          setCatalog(body);
        })
        .catch((err: unknown) => {
          console.error("[PolicyBuilder] catalog fetch failed", err);
          setError(
            err instanceof Error ? err.message : "Could not read the contract"
          );
          setCatalog(null);
        })
        .finally(() => setLoading(false));
    },
    [organizationId]
  );

  const reset = useCallback(() => {
    setCatalog(null);
    setError(null);
  }, []);

  return { catalog, loading, error, load, reset };
}
