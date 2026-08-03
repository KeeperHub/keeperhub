---
title: "Organizations API"
description: "KeeperHub Organizations API - manage organization membership."
---

# Organizations API

Manage organization membership programmatically.

## Leave Organization

```http
POST /api/organizations/{organizationId}/leave
```

Remove yourself from an organization. If you are the sole owner, you must transfer ownership by providing `newOwnerMemberId` in the request body. The new owner must be an accepted member of the organization.

### Request Body

```json
{
  "newOwnerMemberId": "member_456"
}
```

The `newOwnerMemberId` field is only required when you are the last remaining owner.
