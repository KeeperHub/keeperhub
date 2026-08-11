"use client";

import { Bookmark, Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { truncateAddress } from "@/lib/address-utils";
import type { AddressBookEntry } from "@/lib/api-client";
import { addressBookApi } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";

type AddressSelectPopoverProps = {
  children: React.ReactElement;
  isOpen: boolean;
  onAddressSelect: (address: string, bookmarkId: string) => void;
  onClose: () => void;
  selectedBookmarkId?: string;
};

function AddressSelectItem({
  entry,
  selectedBookmarkId,
  onSelect,
}: {
  entry: AddressBookEntry;
  selectedBookmarkId?: string;
  onSelect: (address: string, bookmarkId: string) => void;
}) {
  return (
    <CommandItem
      key={entry.id}
      onSelect={() => onSelect(entry.address, entry.id)}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex flex-col">
          <div className="flex items-center gap-1">
            <Bookmark className="h-2 w-2 text-primary" fill="currentColor" />
            <span className="font-medium text-sm">{entry.label}</span>
          </div>
          <span className="font-mono text-muted-foreground text-xs">
            {truncateAddress(entry.address)}
          </span>
        </div>
        {selectedBookmarkId === entry.id && (
          <Check className="h-4 w-4 text-primary" />
        )}
      </div>
    </CommandItem>
  );
}

export function AddressSelectPopover({
  children,
  isOpen,
  onAddressSelect,
  onClose,
  selectedBookmarkId,
}: AddressSelectPopoverProps) {
  const { data: session } = useSession();
  const [addressBookEntries, setAddressBookEntries] = useState<
    AddressBookEntry[]
  >([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [popoverWidth, setPopoverWidth] = useState<number | undefined>(
    undefined
  );
  const anchorRef = useRef<HTMLDivElement>(null);

  const isTemporalAccount =
    !session?.user ||
    session.user.name === "Anonymous" ||
    session.user.email?.startsWith("temp-");

  const shouldOpen = isOpen && !isTemporalAccount;

  const loadAddressBookEntries = useCallback(async () => {
    if (isTemporalAccount) {
      setLoadingEntries(false);
      return;
    }

    setLoadingEntries(true);
    try {
      const entries = await addressBookApi.getAll();
      setAddressBookEntries(entries);
    } catch (error) {
      console.error("Failed to load address book entries:", error);
    } finally {
      setLoadingEntries(false);
    }
  }, [isTemporalAccount]);

  useEffect(() => {
    if (shouldOpen) {
      loadAddressBookEntries();
    }
  }, [shouldOpen, loadAddressBookEntries]);

  useEffect(() => {
    if (shouldOpen && anchorRef.current) {
      const updateWidth = () => {
        if (anchorRef.current) {
          setPopoverWidth(anchorRef.current.offsetWidth);
        }
      };

      updateWidth();
      window.addEventListener("resize", updateWidth);

      return () => {
        window.removeEventListener("resize", updateWidth);
      };
    }
  }, [shouldOpen]);

  const handleSelect = (address: string, bookmarkId: string) => {
    onAddressSelect(address, bookmarkId);
    onClose();
  };

  return (
    <Popover open={shouldOpen}>
      <PopoverAnchor asChild>
        <div ref={anchorRef}>{children}</div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="p-0"
        onEscapeKeyDown={onClose}
        onInteractOutside={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest('[data-slot="popover-content"]')) {
            e.preventDefault();
          }
        }}
        onOpenAutoFocus={(event: Event) => event.preventDefault()}
        style={popoverWidth ? { width: `${popoverWidth}px` } : undefined}
      >
        <Command>
          <CommandInput placeholder="Search addresses..." />
          <CommandList>
            {loadingEntries && (
              <div className="py-6 text-center text-muted-foreground text-sm">
                Loading addresses...
              </div>
            )}
            {!loadingEntries && addressBookEntries.length === 0 && (
              <CommandEmpty>No addresses saved yet</CommandEmpty>
            )}
            {!loadingEntries && addressBookEntries.length > 0 && (
              <CommandGroup heading="Saved Addresses">
                {addressBookEntries.map((entry) => (
                  <AddressSelectItem
                    entry={entry}
                    key={entry.id}
                    onSelect={handleSelect}
                    selectedBookmarkId={selectedBookmarkId}
                  />
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
