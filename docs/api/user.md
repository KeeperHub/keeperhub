---
title: "User API"
description: "KeeperHub User API - manage user profile and wallet."
---

# User API

Manage user profile and preferences.

> **Authentication.** Profile and wallet read operations in this section accept either a session cookie or an organization API key (`kh_`). Mutating operations require **session authentication** and reject API keys with `401`: profile mutation, password change, forgot-password, account deactivation, and every wallet write operation (withdraw, share, refresh-share, export-key, active wallet switch, fee estimation). Address book entries are organization-scoped and accept either method. See [Authentication](/api/authentication#endpoint-scope) for the full scope rules.

## Get User Profile

```http
GET /api/user
```

### Response

```json
{
  "id": "user_123",
  "name": "John Doe",
  "email": "john@example.com",
  "image": "https://...",
  "isAnonymous": false,
  "providerId": "google",
  "walletAddress": "0x..."
}
```

`walletAddress` is the **active organization's** wallet, the address that signs
and funds executions. It is not the address a wallet (`providerId: "siwe"`) user
signed in with, and the two differ. It is the address to fund before a first
write.

## Update User Profile

```http
PATCH /api/user
```

Note: OAuth users cannot update email or name.

### Request Body

```json
{
  "name": "New Name"
}
```

## Get Wallet

```http
GET /api/user/wallet
```

Returns the Turnkey wallet for the authenticated user's active organization. The wallet is organization-scoped, not per-user.

### Response

```json
{
  "hasWallet": true,
  "id": "wallet_...",
  "canExportKey": true,
  "isOwner": true,
  "walletAddress": "0x...",
  "solanaAddress": null,
  "walletId": "turnkey_wallet_...",
  "email": "wallet@example.com",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "organizationId": "org_...",
  "isActive": true
}
```

`walletAddress` is the EVM address; `solanaAddress` is present when the wallet has a Solana
address and `null` otherwise.

When the organization has no wallet yet, the response is `{ "hasWallet": false, "message": "No wallet found for this organization" }`.

Balances are not included here. Fetch them from `GET /api/user/wallet/balances`.

## Change Password

```http
POST /api/user/password
```

Change the password for a credential-based account. Requires the current password and a new password (minimum 8 characters). Not available for OAuth-only accounts.

### Request Body

```json
{
  "currentPassword": "old-password",
  "newPassword": "new-password"
}
```

## Forgot Password

```http
POST /api/user/forgot-password
```

Handles password reset via OTP. Supports two actions controlled by the `action` field in the request body.

**Request OTP** (default when `action` is omitted or set to `"request"`):

```json
{
  "email": "user@example.com"
}
```

**Reset password** (`action: "reset"`):

```json
{
  "action": "reset",
  "email": "user@example.com",
  "otp": "123456",
  "newPassword": "new-password"
}
```

The OTP expires after 5 minutes. OAuth-only accounts receive a notification email instead of a reset code.

## Deactivate Account

```http
POST /api/user/delete
```

Soft-deletes the authenticated user account. Requires a confirmation string in the request body. Invalidates all active sessions on success. Not available for anonymous users.

### Request Body

```json
{
  "confirmation": "DEACTIVATE"
}
```

## Address Book

Manage saved Ethereum addresses scoped to the active organization. All address book endpoints require an active organization context.

### List Address Book Entries

```http
GET /api/address-book
```

Returns all address book entries for the active organization, ordered by creation date (newest first).

### Create Address Book Entry

```http
POST /api/address-book
```

#### Request Body

```json
{
  "label": "Treasury Wallet",
  "address": "0x..."
}
```

The address must be a valid Ethereum address.

### Update Address Book Entry

```http
PATCH /api/address-book/{entryId}
```

Update the label or address of an existing entry. Both fields are optional.

### Delete Address Book Entry

```http
DELETE /api/address-book/{entryId}
```

Removes the entry from the organization address book.
