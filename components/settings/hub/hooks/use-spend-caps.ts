"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  fetchSpendCap,
  type SpendCap,
  type SpendCapResponse,
  spendCapCacheKey,
  toSpendCaps,
} from "@/lib/wallet/spend-cap";
import { useSettingsContext } from "../settings-context";
import { useCachedSection } from "./use-cached-section";

export {
  EVM_DECIMALS,
  SOLANA_DECIMALS,
  type SpendCap,
} from "@/lib/wallet/spend-cap";

export type SpendCapsState = {
  caps: SpendCap[];
  loading: boolean;
  saving: boolean;
  save: (id: "evm" | "solana", base: string | null) => Promise<void>;
};

const FIELD: Record<"evm" | "solana", string> = {
  evm: "dailyValueCapWei",
  solana: "dailySolanaValueCapLamports",
};

export function useSpendCaps(): SpendCapsState {
  const { organizationId } = useSettingsContext();
  const [saving, setSaving] = useState(false);
  const section = useCachedSection<SpendCapResponse | null>(
    spendCapCacheKey(organizationId),
    fetchSpendCap
  );
  const data = section.data ?? null;
  const loading = section.loading;
  const refetch = section.refetch;
  const save = useCallback(
    async (id: "evm" | "solana", base: string | null): Promise<void> => {
      setSaving(true);
      try {
        const res = await fetch("/api/analytics/spend-cap", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [FIELD[id]]: base }),
        });
        if (res.ok) {
          // Read the saved value back rather than patching a copy, so the
          // cache other sections read from holds what the server has.
          await refetch();
          toast.success(
            base ? "Cap saved" : "Cap cleared - the platform default applies"
          );
          return;
        }
        toast.error(
          res.status === 403
            ? "Only organization owners and admins can change the cap"
            : "Could not save the cap"
        );
      } catch {
        toast.error("Could not save the cap");
      } finally {
        setSaving(false);
      }
    },
    [refetch]
  );

  return { caps: toSpendCaps(data), loading, saving, save };
}
