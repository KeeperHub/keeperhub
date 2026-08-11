---
title: "Tags API"
description: "KeeperHub Tags API - organize workflows with custom tags and public tags."
---

# Tags API

Manage workflow organization tags.

## Organization Tags

Organization tags are private labels for categorizing workflows within your organization.

### List Organization Tags

```http
GET /api/tags
```

Returns all tags for the current organization, including workflow counts.

#### Response

```json
[
  {
    "id": "tag_123",
    "name": "Production",
    "color": "#4A90D9",
    "organizationId": "org_456",
    "userId": "user_789",
    "workflowCount": 12,
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
]
```

### Create Organization Tag

```http
POST /api/tags
```

#### Request Body

```json
{
  "name": "My Tag",
  "color": "#7B61FF"
}
```

Both fields are required.

### Update Organization Tag

```http
PATCH /api/tags/{tagId}
```

#### Request Body

```json
{
  "name": "Updated Name",
  "color": "#E06C75"
}
```

Both fields are optional. Only provided fields are updated.

### Delete Organization Tag

```http
DELETE /api/tags/{tagId}
```

Deletes the tag. Workflows assigned to this tag become untagged.

## Public Tags

Public tags are system-wide labels used for categorizing public workflows in the hub.

### List Public Tags

```http
GET /api/public-tags
```

Returns all public tags with workflow counts.

#### Response

```json
[
  {
    "id": "tag_1",
    "name": "DeFi",
    "slug": "defi",
    "workflowCount": 42,
    "createdAt": "2024-01-01T00:00:00Z"
  }
]
```

### Create Public Tag

```http
POST /api/public-tags
```

Creates a new public tag. Requires authentication.

#### Request Body

```json
{
  "name": "NFT"
}
```

The slug is automatically generated from the name (e.g., "NFT" becomes "nft").
