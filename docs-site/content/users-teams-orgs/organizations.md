---
title: "Organizations"
description: "Create and manage organizations to collaborate on workflows with team members in KeeperHub."
---

# Organizations

Organizations allow multiple users to collaborate on workflows. All members of an organization share access to workflows created within that organization.

## Accessing Organizations

Open the "Manage Organizations" modal from the user menu to view and manage your organizations.

The modal contains two tabs:

- **Organizations**: View and manage organizations you belong to
- **Invitations**: View pending invitations from other organizations

## Creating an Organization

To create a new organization:

1. Open the Manage Organizations modal
2. Click "Create Organization"
3. Enter the required information:
   - **Organization Name**: Display name for the organization (e.g., "Acme Inc.")
   - **Slug**: URL identifier for the organization (e.g., "acme-inc")
4. Submit to create the organization

The slug is used in URLs and must be unique. It should contain only lowercase letters, numbers, and hyphens.

## Inviting Members

Organization members can invite others to join:

1. Navigate to the organization settings
2. Enter the email address of the person to invite
3. Send the invitation

The invited user will see the invitation in their Invitations tab and can accept or decline.

**Note**: Invitations are created successfully even if the invitation email fails to deliver. The invitation remains valid and can be accessed through the invitation link or the user's Invitations tab.

## Managing Invitations

In the Invitations tab:

- View all pending invitations
- Accept invitations to join organizations
- Decline invitations you do not wish to accept

When no invitations are pending, the tab displays "No pending invitations."

## Shared Workflows

Workflows created within an organization are automatically shared with all members:

- All members can view organization workflows
- All members can edit organization workflows
- All members can view run history
- All members can enable or disable workflows

## Leaving an Organization

Members can leave an organization at any time:

1. Open the Manage Organizations modal
2. Select the organization you want to leave
3. Click **Leave Organization**

If you are the sole owner, you must transfer ownership to another accepted member before leaving. Select a member to promote to owner during the leave process.

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
