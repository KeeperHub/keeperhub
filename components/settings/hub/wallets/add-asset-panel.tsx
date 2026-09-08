"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ChainData } from "@/lib/wallet/types";

/**
 * Tracks a token the balance feed does not know about. Inline rather than a
 * dialog: it belongs to the list it adds a row to.
 */
export function AddAssetPanel({
  chains,
  defaultChainId,
  onAdd,
  onCancel,
}: {
  chains: ChainData[];
  defaultChainId?: string;
  onAdd: (chainId: number, tokenAddress: string) => Promise<void>;
  onCancel: () => void;
}): React.ReactElement {
  const [chainId, setChainId] = useState(
    defaultChainId ?? String(chains[0]?.chainId ?? "")
  );
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    setSaving(true);
    try {
      await onAdd(Number(chainId), address.trim());
      setAddress("");
      onCancel();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="m-2 flex flex-wrap items-end gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="add-asset-network">Network</Label>
        <Select onValueChange={setChainId} value={chainId}>
          <SelectTrigger className="w-48" id="add-asset-network">
            <SelectValue placeholder="Select a network" />
          </SelectTrigger>
          <SelectContent>
            {chains.map((chain) => (
              <SelectItem key={chain.chainId} value={String(chain.chainId)}>
                {chain.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex min-w-64 flex-1 flex-col gap-2">
        <Label htmlFor="add-asset-address">Token address</Label>
        <Input
          id="add-asset-address"
          onChange={(event) => setAddress(event.target.value)}
          placeholder="0x..."
          value={address}
        />
      </div>

      <div className="flex gap-2">
        <Button onClick={onCancel} variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={saving || !(address.trim() && chainId)}
          onClick={() => {
            submit().catch(() => undefined);
          }}
        >
          {saving ? "Adding..." : "Add asset"}
        </Button>
      </div>
    </div>
  );
}
