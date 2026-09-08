"use client";

import { ethers } from "ethers";
import { Bookmark } from "lucide-react";
import { Button } from "@/components/ui/button";

type SaveAddressButtonProps = {
  address: string;
  onClick: () => void;
};

export function SaveAddressButton({
  address,
  onClick,
}: SaveAddressButtonProps) {
  const isValidAddress = address && ethers.isAddress(address);

  return (
    <Button
      className="h-[38px] gap-2 border border-gray-700 disabled:opacity-60"
      disabled={!isValidAddress}
      onClick={onClick}
      size="sm"
      type="button"
      variant="ghost"
    >
      <Bookmark className="h-4 w-4" fill="currentColor" />
      Save
    </Button>
  );
}
