---
title: "Address Book"
description: "Save and manage frequently used blockchain addresses for quick reuse across workflows in KeeperHub."
---

# Address Book

The address book lets you save and label blockchain addresses that your organization uses frequently. Saved addresses are available across all workflows, so you do not need to copy and paste the same addresses repeatedly.

Address book entries are **organization-scoped** -- every member of your organization can view and use them.

## Adding an Address

There are two ways to save an address:

**From the address book page**: Click **Add Address**, enter a label (for example, "Treasury Wallet") and a valid Ethereum address, then click **Save**.

**From a workflow node field**: When you enter a valid address into any address-type field in the workflow builder, a **Save** button appears next to the input. Click it to open the save form with the address pre-filled. Provide a label and confirm.

Both methods validate the address format before saving. Invalid addresses are rejected with an error message.

## Editing an Address

Click the **Edit** icon next to any entry in the address book table. You can update the label, the address, or both. The address is re-validated on save.

## Removing an Address

Click the **Delete** icon next to any entry. The entry is removed immediately. Removing an address book entry does not alter workflow nodes that already reference that address -- the address value remains in the node configuration.

## Checksummed Address Display

All addresses are stored in lowercase for consistency and displayed in **EIP-55 checksummed format**. This means mixed-case characters serve as a built-in integrity check, helping you verify that an address has not been corrupted.

When you copy an address from the address book, the checksummed form is copied to your clipboard.

## Using Addresses in Workflow Nodes

When you focus an address-type input field in the workflow builder, a **popover** appears showing your saved addresses. You can search by label or address, then select an entry to populate the field.

The selected bookmark is persisted in the node configuration. If you open the workflow later, the field retains its association with the address book entry.

## Block Explorer Links

KeeperHub generates block explorer links for addresses and transaction hashes based on the selected network. Clicking an address or transaction hash link opens the relevant page on the network's block explorer (for example, Etherscan for Ethereum Mainnet).

Explorer URL construction uses the chain's configured `explorerUrl` and `explorerAddressPath`, so links work automatically for any supported network.
