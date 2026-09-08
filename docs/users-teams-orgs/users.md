---
title: "User Management"
description: "Managing your KeeperHub user account, profile settings, and personal preferences."
---

# User Management

Your KeeperHub user account is the foundation of your platform access. This guide covers account management and user settings.

## Account Creation

New users can create an account through:

- **Email Registration**: Sign up with email and password
- **Social Authentication**: Connect via supported OAuth providers

Upon account creation, a Turnkey wallet is automatically provisioned for your organization once your email is verified.

## User Profile

Your profile contains:

- **Display Name**: How you appear to other organization members
- **Email Address**: Used for account access and notifications
- **Wallet Address**: Your organization's Turnkey wallet address

## Account Settings

Open Settings from the user menu. Your own account lives under the Account
group, which is split in two:

**Profile** holds who you are and the organizations inviting you:

- Update display name
- Change email address
- Accept or decline organization invitations
- Deactivate your account

**Account security** holds how you sign in:

- Change your password
- Two-factor authentication
- Wallet step-up confirmation
- Review and revoke active sessions

Your organization's wallet is not part of your personal account. It sits under
Settings > Organization > Wallets.

## Password Management

### Changing Your Password

You can change your password from Settings > Account > Account security. Enter your current password, then provide and confirm a new password. Passwords must be at least 8 characters. You will be signed out after changing your password and must sign in again.

### Forgot Password

If you forget your password, use the forgot password flow from the sign-in page. Enter your email address and a one-time verification code (OTP) will be sent to you. The code expires after 5 minutes. Enter the code along with your new password to complete the reset.

### OAuth Users

If you signed up with a social provider (Google or GitHub), your password is managed by that provider. The change password option will direct you to your provider's account settings. If you attempt a password reset, you will receive an email indicating which provider manages your account.

## Personal Workflows

As an individual user, you can:

- Create workflows in your personal workspace
- Test and deploy automations
- Access your run history
- Manage notification connections

## Organization Membership

Users can belong to one or more organizations:

- Accept invitations to join organizations
- Access shared workflows within organizations
- Collaborate with organization members

See [Organizations](/users-teams-orgs/organizations) for details on organization features.

## API Access

Generate API keys for programmatic access:

- Create keys for workflow management
- Set appropriate scopes for each key
- Rotate keys for security

See [API Authentication](/api/authentication) for details.

## Data and Privacy

- Your workflows and run data are private to you and your organizations
- Turnkey wallet private keys stay inside secure hardware enclaves and are never stored by KeeperHub

### Account Deactivation

You can deactivate your account from Settings > Account > Profile. To confirm, you must type **DEACTIVATE** in the confirmation dialog. Deactivation is a soft delete: your data is preserved, but you will be signed out and unable to sign in. All active sessions are invalidated immediately. To reactivate a deactivated account, contact an administrator.
