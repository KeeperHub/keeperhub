# Organization Implementation

> **Implementation Approach:** This feature is built using [better-auth's organization plugin](https://www.better-auth.com/docs/plugins/organization), which provides built-in multi-tenancy, RBAC, invitation system, and session-based organization switching.
>
> **Detailed Strategy:** See [organization-implementation-strategy.md](./organization-implementation-strategy.md) for complete technical implementation details.

## Core Requirements

1. **Authenticated users must belong to an organization** - no standalone/personal mode
2. **Registration flow** - users either create a new organization OR join an existing one via invite
3. **Multi-org support** - users can belong to multiple organizations and switch between them
4. **wallet is organization-scoped** - whoever creates the wallet chooses the email (e.g., `treasury@company.com`)
5. **Anonymous users can trial the app** - they cannot join orgs, workflows are temporary/user-scoped

## User Types

| User Type     | Org Required | Can Create Workflows | Can Join Org | Can Create wallet |
| ------------- | ------------ | -------------------- | ------------ | --------------------- |
| Anonymous     | No           | Yes (trial mode)     | No           | No                    |
| Authenticated | Yes          | Yes (org-scoped)     | Yes          | Yes (if owner/admin)  |

## Registration Flow

```
User registers (or links anonymous account)
     ↓
Choose: "Create Organization" or "Enter Invite Code"
     ↓                              ↓
Create org (becomes owner)    Join org (role set by inviter)
     ↓                              ↓
            → Dashboard (always in org context)
```

## Org Removal Handling

If a user is removed from their only organization:

- Redirect to "Create or Join Organization" screen
- They cannot access the main app until they belong to an org again

## Invite System

- Owners and admins can invite users
- Role is set per invite (owner, admin, or member)
- Invite via email or shareable link with code
- Invitations expire after 7 days
- Email delivery via SendGrid plugin integration

**Technical Implementation:**
- Uses better-auth's built-in invitation system
- Invitation records stored in database with status tracking (pending/accepted/rejected/cancelled)
- Email template customizable via `sendInvitationEmail` hook

## wallet Ownership

- One wallet per organization
- Created by owner or admin
- Email is manually specified (not auto-filled from user's email)
- All org members can use the wallet for signing

**Technical Implementation:**
- wallet credentials are scoped by `organizationId`
- Access control enforced via better-auth permissions: `wallet: ["create", "read", "update", "delete"]`
- Members have read-only permission (can use wallet), admins/owners can manage

## Anonymous User Flow

Anonymous users can trial the app but their workflows are discarded when they create a real account.

Rationale: Anonymous users cannot create wallets, so trial workflows have no real utility in an org context.

```
Anonymous creates workflows (trial only)
     ↓
Links account → trial workflows are deleted
     ↓
Creates/joins org → starts fresh with org-scoped workflows
```
