---
title: "Workflows API"
description: "KeeperHub Workflows API - create, read, update, delete, and execute workflows."
---

# Workflows API

Manage workflows programmatically.

## List Workflows

```http
GET /api/workflows
```

Returns all workflows for the authenticated user (session) or organization (API key).

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `projectId` | string | Optional. Filter workflows by project ID |
| `tagId` | string | Optional. Filter workflows by tag ID |

### Example

```http
GET /api/workflows?projectId=proj_123&tagId=tag_456
```

### Response

```json
[
  {
    "id": "wf_123",
    "name": "My Workflow",
    "description": "Monitors ETH balance",
    "visibility": "private",
    "nodes": [],
    "edges": [],
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
]
```

## Get Workflow

```http
GET /api/workflows/{workflowId}
```

Returns a single workflow by ID.

### Response

```json
{
  "id": "wf_123",
  "name": "My Workflow",
  "description": "Monitors ETH balance",
  "visibility": "private",
  "nodes": [...],
  "edges": [...],
  "publicTags": [
    {
      "id": "tag_1",
      "name": "DeFi",
      "slug": "defi"
    }
  ],
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z",
  "isOwner": true
}
```

Public workflows include a `publicTags` array showing all assigned tags.

## Create Workflow

```http
POST /api/workflows/create
```

### Request Body

```json
{
  "name": "New Workflow",
  "description": "Optional description",
  "projectId": "proj_123"
}
```

The `projectId` field is optional. If provided, the workflow is assigned to the specified [project](/api/projects).

### Response

Returns the created workflow with a default trigger node and an empty action node connected to it.

## Update Workflow

```http
PATCH /api/workflows/{workflowId}
```

### Request Body

```json
{
  "name": "Updated Name",
  "description": "Updated description",
  "projectId": "proj_123",
  "tagId": "tag_456",
  "nodes": [...],
  "edges": [...],
  "visibility": "private"
}
```

The `tagId` field assigns the workflow to an organization tag for categorization.

## Delete Workflow

```http
DELETE /api/workflows/{workflowId}
```

## Execute Workflow

```http
POST /api/workflow/{workflowId}/execute
```

Manually trigger a workflow execution.

### Response

```json
{
  "executionId": "exec_123",
  "runId": "run_abc123",
  "status": "pending"
}
```

The `runId` identifies the workflow execution run and is stored in the workflow execution record.

## Webhook Trigger

```http
POST /api/workflows/{workflowId}/webhook
```

Trigger a workflow via webhook. Requires API key authentication.

## Duplicate Workflow

```http
POST /api/workflows/{workflowId}/duplicate
```

Creates a copy of an existing workflow.

## Download Workflow

```http
GET /api/workflows/{workflowId}/download
```

Download workflow definition as JSON.

## Generate Code

```http
GET /api/workflows/{workflowId}/code
```

Generate SDK code for the workflow.

## Claim Workflow

```http
POST /api/workflows/{workflowId}/claim
```

Claim an anonymous workflow into the authenticated user's organization. Only the original creator of the anonymous workflow can claim it.

## Publish Workflow (Go Live)

```http
PUT /api/workflows/{workflowId}/go-live
```

Publish a workflow to make it publicly visible with metadata and tags.

### Request Body

```json
{
  "name": "Public Workflow Name",
  "publicTagIds": ["tag_1", "tag_2"]
}
```

The `name` is required. `publicTagIds` is an array of public tag IDs to associate with the workflow (maximum 5 tags).

## List Public Workflows

```http
GET /api/workflows/public
```

Returns all public workflows with optional filtering.

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `featured` | boolean | Optional. Filter for featured workflows (`?featured=true`) |
| `featuredProtocol` | string | Optional. Filter for protocol-featured workflows (e.g., `?featuredProtocol=sky`) |
| `tag` | string | Optional. Filter by public tag slug (e.g., "defi", "nft") |

### Response

```json
[
  {
    "id": "wf_123",
    "name": "Public Workflow",
    "description": "Description",
    "nodes": [...],
    "edges": [...],
    "publicTags": [
      {
        "id": "tag_1",
        "name": "DeFi",
        "slug": "defi"
      }
    ],
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
]
```

## Workflow Taxonomy

```http
GET /api/workflows/taxonomy
```

Returns distinct categories and protocols from all public workflows. Useful for building filter UIs.

### Response

```json
{
  "categories": ["defi", "nft"],
  "protocols": ["uniswap", "aave"]
}
```

## Update Featured Status (Internal)

```http
POST /api/hub/featured
```

Mark a workflow as featured in the hub. Requires internal service authentication (`hub` service). Accepts optional `category`, `protocol`, and `featuredOrder` fields alongside the `workflowId`.
