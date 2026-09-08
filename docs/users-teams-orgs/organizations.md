---
title: "Organizations"
description: "Create and manage organizations to collaborate on workflows with team members in KeeperHub."
---

# Organizations

Organizations allow multiple users to collaborate on workflows. All members of an organization share access to workflows created within that organization.

## Accessing Organizations

The organization switcher in the top bar lists every organization you belong
to. Selecting one switches to it. Each row also carries a settings icon that
opens that organization's settings without switching to it.

Organization settings live under Settings > Organization:

- **General**: name, slug, and creating another organization
- **Users**: members and the invitations you have sent
- **Organization security**, **Notifications**, **Billing**, **Plans**,
  **Wallets**, **Spending limits**, **Connections**, and **Projects and tags**

Invitations addressed to *you* are personal rather than organizational, so
they sit under Settings > Account > Profile.

## Creating an Organization

To create a new organization:

1. Go to Settings > Organization > General
2. Choose to create an organization
3. Enter the required information:
   - **Organization Name**: Display name for the organization (e.g., "Acme Inc.")
   - **Slug**: URL identifier for the organization (e.g., "acme-inc")
4. Submit to create the organization

The slug is used in URLs and must be unique. It should contain only lowercase letters, numbers, and hyphens.

## Inviting Members

Organization members can invite others to join:

1. Go to Settings > Organization > Users
2. Enter the email address of the person to invite and pick a role
3. Send the invitation

The invited user will see it under Settings > Account > Profile and can accept
or decline. Invitations you have sent stay listed on the Users page until they
are answered.

**Note**: Invitations are created successfully even if the invitation email fails to deliver. The invitation remains valid and can be accessed through the invitation link or under Settings > Account > Profile.

## Managing Invitations

Under Settings > Account > Profile you can:

- View all pending invitations addressed to you
- Accept invitations to join organizations
- Decline invitations you do not wish to accept

## Shared Workflows

Workflows created within an organization are automatically shared with all members:

- All members can view organization workflows
- All members can edit organization workflows
- All members can view run history
- All members can enable or disable workflows

## Leaving an Organization

Members can leave an organization at any time:

1. Go to Settings > Organization > General
2. Under Leave or delete, click **Leave**
3. Confirm

An organization has exactly one owner. If that is you, leaving means handing
it over, so the confirmation asks which accepted member takes it. Pending
invitations do not count: only someone who has already joined can become the
owner.

If you are the owner and the only member, there is nobody to hand it to. Leave
is unavailable and deleting the organization is the way out.

## Deleting an Organization

Only the owner can delete an organization. Go to Settings > Organization >
General and click **Delete** under Leave or delete. Its workflows, members and
wallet go with it, and this cannot be undone.

## Roles

Organizations have three roles: owner, admin, and member. See [Access Control](/users-teams-orgs/permissions) for the full breakdown.

- **Members** collaborate on the organization's workflows: create, edit, delete, enable, disable, and view run history.
- **Admins** can additionally create and revoke organization API keys and view the security audit trail.
- **Owners** control the most sensitive actions: withdrawing funds from the organization wallet, exporting the wallet key, and exporting the audit trail.

### Organization Ownership

The user who creates an organization becomes its owner. Ownership can be transferred to another accepted member, which is required when the sole owner leaves the organization.

## Best Practices

### Naming Conventions

- Use clear, descriptive organization names
- Choose slugs that are easy to remember and type
- Consider using company or project names

### Member Management

- Only invite users who need workflow access
- Communicate with members before making significant changes
- Establish internal guidelines for workflow management

### Workflow Organization

- Use descriptive workflow names
- Include context in workflow descriptions
- Consider naming conventions for different workflow types
