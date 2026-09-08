import { normalizeAddressForStorage } from "@/lib/address-utils";
import { db } from "@/lib/db";
import { addressBookEntry } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

type RecordWalletInAddressBookInput = {
  organizationId: string;
  address: string;
  label: string;
  createdBy?: string | null;
};

/**
 * Insert an address book entry for a wallet that was just created.
 *
 * Idempotent: relies on the unique (organization_id, address) index added
 * in migration 0081. A duplicate (Safe reconciled on a second chain, user
 * manually saved the same address first, etc.) is silently skipped.
 *
 * Non-fatal: errors are logged and swallowed. The address book is a UX
 * convenience - a wallet creation must not roll back because we failed to
 * write a bookmark for it.
 */
export async function recordWalletInAddressBook(
  input: RecordWalletInAddressBookInput
): Promise<void> {
  const { organizationId, address, label, createdBy } = input;

  try {
    await db
      .insert(addressBookEntry)
      .values({
        organizationId,
        label,
        address: normalizeAddressForStorage(address),
        createdBy: createdBy ?? null,
      })
      .onConflictDoNothing({
        target: [addressBookEntry.organizationId, addressBookEntry.address],
      });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[Address Book] Failed to auto-record wallet entry",
      error,
      {
        component: "address-book-record-wallet",
        organization_id: organizationId,
        address,
      }
    );
  }
}
