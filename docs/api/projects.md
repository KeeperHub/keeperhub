---
title: "Projects API"
description: "KeeperHub Projects API - organize workflows into projects with custom colors."
---

# Projects API

Organize workflows into projects for better management.

## List Projects

```http
GET /api/projects
```

Returns all projects for the current organization, including workflow counts.

### Response

```json
[
  {
    "id": "proj_123",
    "name": "DeFi Monitoring",
    "description": "All DeFi-related workflows",
    "color": "#4A90D9",
    "organizationId": "org_456",
    "workflowCount": 5,
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
]
```

## Create Project

```http
POST /api/projects
```

### Request Body

```json
{
  "name": "My Project",
  "description": "Optional description",
  "color": "#7B61FF"
}
```

The `color` field is optional. If omitted, a color is automatically assigned from a default palette.

### Response

Returns the created project with `status: 201`.

## Update Project

```http
PATCH /api/projects/{projectId}
```

### Request Body

All fields are optional. Only provided fields are updated.

```json
{
  "name": "Updated Name",
  "description": "Updated description",
  "color": "#E06C75"
}
```

## Delete Project

```http
DELETE /api/projects/{projectId}
```

Deletes the project. Workflows assigned to this project are not deleted but become unassigned.
