"use client";

import { ethers } from "ethers";
import { Bookmark, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { addressBookApi } from "@/lib/api-client";

type SaveAddressFormProps = {
  address: string;
  onAddressChange: (address: string) => void;
  onCancel: () => void;
  onSave: () => void;
};

export function SaveAddressForm({
  address: initialAddress,
  onAddressChange,
  onCancel,
  onSave,
}: SaveAddressFormProps) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState(initialAddress);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAddress(initialAddress);
  }, [initialAddress]);

  const handleAddressChange = (newAddress: string) => {
    setAddress(newAddress);
    onAddressChange(newAddress);
  };

  const handleSave = async () => {
    if (!label.trim()) {
      toast.error("Please enter a label");
      return;
    }

    if (!(address && ethers.isAddress(address))) {
      toast.error("Invalid address format");
      return;
    }

    setSaving(true);
    try {
      await addressBookApi.create({
        label: label.trim(),
        address,
      });
      toast.success("Address saved to address book");
      setLabel("");
      onSave();
    } catch (error) {
      console.error("Failed to save address:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to save address to address book"
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 rounded-md border bg-muted/50 p-3">
      <p className="text-muted-foreground text-sm">
        Add a new address to your organization's address book for easy reuse
        across workflows.
      </p>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="save-label">Name</Label>
          <Input
            disabled={saving}
            id="save-label"
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Treasury Wallet"
            value={label}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="save-address">Address</Label>
          <Input
            disabled={saving}
            id="save-address"
            onChange={(e) => handleAddressChange(e.target.value)}
            placeholder="0x..."
            value={address}
          />
          {address && !ethers.isAddress(address) && !saving && (
            <p className="text-destructive text-xs">Invalid address format</p>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          className="bg-keeperhub-green hover:bg-keeperhub-green-dark disabled:opacity-70"
          disabled={saving}
          onClick={handleSave}
          size="sm"
          type="button"
        >
          {saving ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <Bookmark className="h-4 w-4" fill="currentColor" />
          )}
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button
          className="flex gap-2"
          disabled={saving}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          <X className="h-4 w-4" />
          Cancel
        </Button>
      </div>
    </div>
  );
}
