---
title: "Access Control"
description: "Roles and permissions in KeeperHub organizations."
---

# Access Control

KeeperHub organizations use three roles: **owner**, **admin**, and **member**. The role controls who can perform sensitive account, wallet, and security actions. Day-to-day workflow collaboration is shared across all members.

## Personal Workspace

In your personal workspace you have full control:

- Full control over all workflows you create
- Complete access to run history
- Management of notification connections
- API key generation and management

## Organization Roles

### Member

Every organization member can collaborate on the organization's workflows:

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

## Policies

Roles answer whether a role may do something. Policies answer whether it may be
done at all, under these conditions, by anyone. They compose in that order, and
a policy can only subtract: it never grants a member something their role
refuses, and a policy refusal overrides even an owner's role.

See [Policies](/api/policies) for how to write one.

## Security Considerations

- Organization members share access to workflows, which can execute transactions from the organization wallet. Be cautious about who you invite to organizations with funded wallets.
- Fund withdrawal, key export, and audit export are restricted to the owner.
- Keep critical wallet operations in organizations with a small, trusted membership.

## Providing Feedback

If you have specific access control requirements, please contact support to share your needs.
