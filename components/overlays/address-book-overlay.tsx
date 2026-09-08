"use client";

import { ethers } from "ethers";
import { Bookmark, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmOverlay } from "@/components/overlays/confirm-overlay";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AddressBookRow } from "@/components/address-book/address-book-row";
import { toChecksumAddress } from "@/lib/address-utils";
import type { AddressBookEntry } from "@/lib/api-client";
import { addressBookApi } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import { useDebounce } from "@/lib/hooks/use-debounce";
import { usePagination } from "@/lib/hooks/use-pagination";

type AddressBookOverlayProps = {
  overlayId: string;
};

type AddAddressOverlayProps = {
  overlayId: string;
  onSave: (label: string, address: string) => Promise<void>;
  entry?: AddressBookEntry;
  initialAddress?: string;
};

export function AddAddressOverlay({
  overlayId,
  onSave,
  entry,
  initialAddress,
}: AddAddressOverlayProps) {
  const { pop } = useOverlay();
  const [newLabel, setNewLabel] = useState(entry?.label ?? "");
  const [newAddress, setNewAddress] = useState(() => {
    if (entry) {
      return toChecksumAddress(entry.address);
    }
    if (initialAddress) {
      return toChecksumAddress(initialAddress);
    }
    return "";
  });
  const [saving, setSaving] = useState(false);

  const isEditing = !!entry;

  const validateInputs = (): boolean => {
    if (!newLabel.trim()) {
      toast.error("Please enter a label");
      return false;
    }

    if (!(newAddress.trim() && ethers.isAddress(newAddress))) {
      toast.error("Please enter a valid Ethereum address");
      return false;
    }

    return true;
  };

  const handleSaveError = (error: unknown) => {
    const action = isEditing ? "update" : "add";
    console.error(`Failed to ${action} address:`, error);
    toast.error(
      error instanceof Error ? error.message : `Failed to ${action} address`
    );
  };

  const handleSave = async () => {
    if (!validateInputs()) {
      return;
    }

    setSaving(true);
    try {
      await onSave(newLabel.trim(), newAddress.trim());
      toast.success(
        isEditing ? "Address updated" : "Address added to address book"
      );
      pop();
    } catch (error) {
      handleSaveError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      actions={[{ label: "Save", onClick: handleSave, loading: saving }]}
      overlayId={overlayId}
      title={isEditing ? "Edit Address" : "Add New Address"}
    >
      <p className="mb-4 text-muted-foreground text-sm">
        {isEditing
          ? "Update the address details in your organization's address book."
          : "Add a new address to your organization's address book for easy reuse across workflows."}
      </p>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="new-label">Name</Label>
          <Input
            disabled={saving}
            id="new-label"
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="e.g. Treasury Wallet"
            value={newLabel}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-address">Address</Label>
          <Input
            disabled={saving}
            id="new-address"
            onChange={(e) => setNewAddress(e.target.value)}
            placeholder="0x..."
            value={newAddress}
          />
          {newAddress && !ethers.isAddress(newAddress) && !saving && (
            <p className="text-destructive text-xs">Invalid address format</p>
          )}
        </div>
      </div>
    </Overlay>
  );
}

type AddressBookSearchAndControlsProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
};

function AddressBookSearchAndControls({
  searchQuery,
  onSearchChange,
}: AddressBookSearchAndControlsProps) {
  return (
    <div className="relative max-w-xs">
      <Search className="-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-muted-foreground" />
      <Input
        className="pl-9"
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search by name..."
        value={searchQuery}
      />
    </div>
  );
}

type AddressBookTableProps = {
  entries: AddressBookEntry[];
  deleting: string | null;
  onDelete: (entry: AddressBookEntry) => void;
  onUpdate: () => void;
  onEdit: (entry: AddressBookEntry) => void;
};

function AddressBookTable({
  entries,
  deleting,
  onDelete,
  onUpdate,
  onEdit,
}: AddressBookTableProps) {
  return (
    <TooltipProvider>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Address</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <AddressBookRow
              deleting={deleting}
              entry={entry}
              key={entry.id}
              onDelete={() => onDelete(entry)}
              onEdit={() => onEdit(entry)}
              onUpdate={onUpdate}
            />
          ))}
        </TableBody>
      </Table>
    </TooltipProvider>
  );
}

type AddressBookPaginationProps = {
  totalItems: number;
  itemsPerPage: number;
  showingFrom: number;
  showingTo: number;
  currentPage: number;
  pageNumbers: (number | string)[];
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onGoToPage: (page: number) => void;
};

function AddressBookPagination({
  totalItems,
  itemsPerPage,
  showingFrom,
  showingTo,
  currentPage,
  pageNumbers,
  canGoPrevious,
  canGoNext,
  onPreviousPage,
  onNextPage,
  onGoToPage,
}: AddressBookPaginationProps) {
  if (totalItems <= itemsPerPage) {
    return null;
  }

  return (
    <div className="flex items-center justify-between">
      <p className="text-muted-foreground text-sm">
        Showing {showingFrom}-{showingTo} of {totalItems} entries
      </p>
      <div className="flex items-center gap-2">
        <Button
          disabled={!canGoPrevious}
          onClick={onPreviousPage}
          size="sm"
          variant="ghost"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <div className="flex items-center gap-1">
          {pageNumbers.map((page: number | string) => {
            if (typeof page === "string") {
              return (
                <span className="px-2 text-muted-foreground" key={page}>
                  ...
                </span>
              );
            }

            const isCurrentPage = page === currentPage;
            return (
              <Button
                key={page}
                onClick={() => onGoToPage(page)}
                size="sm"
                variant={isCurrentPage ? "default" : "ghost"}
              >
                {page}
              </Button>
            );
          })}
        </div>

        <Button
          disabled={!canGoNext}
          onClick={onNextPage}
          size="sm"
          variant="ghost"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export function AddressBookOverlay({ overlayId }: AddressBookOverlayProps) {
  const { push, closeAll } = useOverlay();
  const { data: session } = useSession();
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<AddressBookEntry[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const isTemporalAccount =
    !session?.user ||
    session.user.name === "Anonymous" ||
    session.user.email?.startsWith("temp-");

  const debouncedSearchQuery = useDebounce(searchQuery, 500);

  const filteredEntries = useMemo(() => {
    if (!debouncedSearchQuery.trim()) {
      return entries;
    }

    const query = debouncedSearchQuery.trim().toLowerCase();
    return entries.filter((entry) => entry.label.toLowerCase().includes(query));
  }, [entries, debouncedSearchQuery]);

  const {
    paginatedItems: paginatedEntries,
    currentPage,
    itemsPerPage,
    goToNextPage,
    goToPreviousPage,
    goToPage,
    canGoNext,
    canGoPrevious,
    showingFrom,
    showingTo,
    totalItems,
    pageNumbers,
  } = usePagination<AddressBookEntry>(filteredEntries, {
    defaultItemsPerPage: 25,
  });

  const loadEntries = useCallback(async () => {
    if (isTemporalAccount) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const data = await addressBookApi.getAll();
      setEntries(data);
    } catch (error) {
      console.error("Failed to load address book entries:", error);
      toast.error("Failed to load address book");
    } finally {
      setLoading(false);
    }
  }, [isTemporalAccount]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const handleAddAddress = async (label: string, address: string) => {
    await addressBookApi.create({ label, address });
    await loadEntries();
  };

  const handleUpdateAddress = async (
    entryId: string,
    label: string,
    address: string
  ) => {
    await addressBookApi.update(entryId, {
      label,
      address,
    });
    await loadEntries();
  };

  const handleOpenAddForm = () => {
    push(AddAddressOverlay, {
      onSave: handleAddAddress,
    });
  };

  const handleOpenEditForm = (entry: AddressBookEntry) => {
    push(AddAddressOverlay, {
      entry,
      onSave: async (label: string, address: string) => {
        await handleUpdateAddress(entry.id, label, address);
      },
    });
  };

  const handleDelete = (entry: AddressBookEntry) => {
    push(ConfirmOverlay, {
      title: "Delete Address",
      message: `Are you sure you want to delete "${entry.label}" from the address book?`,
      confirmLabel: "Delete",
      confirmVariant: "destructive" as const,
      destructive: true,
      onConfirm: async () => {
        setDeleting(entry.id);
        try {
          await addressBookApi.delete(entry.id);
          toast.success("Address deleted");
          await loadEntries();
        } catch (error) {
          console.error("Failed to delete address:", error);
          toast.error(
            error instanceof Error ? error.message : "Failed to delete address"
          );
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  return (
    <Overlay
      actions={[
        ...(isTemporalAccount
          ? []
          : [
              {
                label: "Add New Address",
                variant: "outline" as const,
                onClick: handleOpenAddForm,
              },
            ]),
        { label: "Done", onClick: closeAll },
      ]}
      overlayId={overlayId}
      title="Address Book"
    >
      <div className="space-y-4">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        )}
        {!loading && isTemporalAccount && (
          <div className="py-8 text-center text-muted-foreground text-sm">
            <Bookmark className="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p>Please sign in to access address book</p>
          </div>
        )}
        {!(loading || isTemporalAccount) && entries.length === 0 && (
          <div className="py-8 text-center text-muted-foreground text-sm">
            <Bookmark className="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p>No addresses saved yet</p>
          </div>
        )}
        {!(loading || isTemporalAccount) && entries.length > 0 && (
          <>
            <AddressBookSearchAndControls
              onSearchChange={setSearchQuery}
              searchQuery={searchQuery}
            />

            {filteredEntries.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground text-sm">
                <Bookmark className="mx-auto mb-2 h-8 w-8 opacity-50" />
                <p>No addresses found matching "{debouncedSearchQuery}"</p>
              </div>
            ) : (
              <>
                <AddressBookTable
                  deleting={deleting}
                  entries={paginatedEntries}
                  onDelete={handleDelete}
                  onEdit={handleOpenEditForm}
                  onUpdate={loadEntries}
                />

                <AddressBookPagination
                  canGoNext={canGoNext}
                  canGoPrevious={canGoPrevious}
                  currentPage={currentPage}
                  itemsPerPage={itemsPerPage}
                  onGoToPage={goToPage}
                  onNextPage={goToNextPage}
                  onPreviousPage={goToPreviousPage}
                  pageNumbers={pageNumbers}
                  showingFrom={showingFrom}
                  showingTo={showingTo}
                  totalItems={totalItems}
                />
              </>
            )}
          </>
        )}
      </div>
    </Overlay>
  );
}
