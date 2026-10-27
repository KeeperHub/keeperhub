---
title: "Access Control"
description: "Roles and permissions in KeeperHub organizations."
---

# Access Control

KeeperHub organizations use four roles: **owner**, **admin**, **member**, and **viewer**. The role controls who can change the organization and who can perform sensitive account, wallet, and security actions. Day-to-day workflow collaboration is shared across members, admins, and owners, and viewers get read-only access.

## Personal Workspace

In your personal workspace you have full control:

- Full control over all workflows you create
- Complete access to run history
- Management of notification connections
- API key generation and management

## Organization Roles

### Viewer

Viewers can see everything in the organization and change nothing. The role suits auditors, stakeholders, and anyone who needs visibility without edit rights:

- View all organization workflows, including their steps, run history, and version history
- View projects, tags, connections, the address book, wallets and balances, and organization settings

Viewers work in the browser. API keys, MCP agent connections, and CLI login require the member role or higher. Viewers keep control of their own account (profile, password, two-factor authentication, and sessions) and can leave the organization at any time.

When a member is changed to viewer, the API keys, webhook keys, and agent connections they use with the organization stop working right away. Scheduled and event-triggered workflows keep running.

### Member

Members collaborate on the organization's workflows:

- View all organization workflows
- Create, edit, and delete workflows
- Enable and disable workflows
- View run history for all workflows

### Admin

Admins have every member permission plus organization key management:

- Create and revoke organization (`kh_`) API keys
- View the organization's security audit trail

### Owner

The owner has full control, including the most sensitive wallet and security actions:

- Withdraw funds from the organization wallet
- Export the wallet private key
- Export the security audit trail
- Everything admins and members can do

The user who creates an organization becomes its owner. Ownership can be transferred to another accepted member, for example when the sole owner leaves the organization.

## Audit Trail

Owners and admins can view the organization's security audit trail. It records sensitive actions (member changes, API key creation and revocation, wallet approvals, and settings changes) with the acting user and a timestamp.

## Step-Up Verification

Sensitive owner actions such as withdrawing funds, exporting the wallet key, and exporting the audit trail require step-up verification (a second factor) in addition to the role check.

## Security Considerations

- Organization members share access to workflows, which can execute transactions from the organization wallet. Be cautious about who you invite to organizations with funded wallets.
- Fund withdrawal, key export, and audit export are restricted to the owner.
- Keep critical wallet operations in organizations with a small, trusted membership.
- Invite people who only need to follow along as viewers, so they can see workflows and runs without being able to run or change them.

## Providing Feedback

If you have specific access control requirements, please contact support to share your needs.
