# Workflow Projects - Feature Spec

## Problem

Users managing workflows across multiple protocols end up with a flat list of 20-30+ workflows with no way to scope down. A user monitoring Sky ESM, Aave liquidations, and Compound governance has to scroll and mentally parse the full list every time. There's no "show me just my Sky stuff" view.

## Solution

Add a **Projects** concept -- a simple one-to-one grouping (like folders) that lets users organize workflows by protocol operation, then scope the workflow list to a single project.

## Data Model

### New table: `projects`

| Column | Type | Notes |
|--------|------|-------|
| id | text (nanoid) | Primary key |
| name | text | Required. e.g. "Sky ESM Monitoring" |
| description | text | Optional. Brief summary of what this group of workflows does |
| color | text | Optional. Hex color for sidebar badge, defaults to a system color |
| organizationId | text | FK to organizations. Scoped to org |
| userId | text | Creator |
| createdAt | timestamp | |
| updatedAt | timestamp | |

### Workflow table change

Add `projectId` (text, nullable, FK to projects) to the existing `workflows` table. Nullable so existing workflows aren't broken -- they show up as "Uncategorized" until assigned.

### Constraints

- One-to-one: a workflow belongs to zero or one project
- Deleting a project nulls the `projectId` on its workflows (does NOT delete workflows)
- Projects are scoped to an organization

## API

### Project CRUD

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all projects for the current org |
| POST | `/api/projects` | Create a project (`name`, optional `description`, `color`) |
| PATCH | `/api/projects/[id]` | Update project name/description/color |
| DELETE | `/api/projects/[id]` | Delete project (nulls `projectId` on member workflows) |

### Workflow changes

- `POST /api/workflows/create` -- accept optional `projectId`
- `PATCH /api/workflows/[id]` -- accept optional `projectId` (assign/reassign/unassign)
- `GET /api/workflows` -- accept optional `?projectId=` query param to filter

### Response shape: Project

```json
{
  "id": "proj_abc123",
  "name": "Sky ESM Monitoring",
  "description": "Emergency shutdown module monitoring for Sky/MakerDAO",
  "color": "#4A90D9",
  "workflowCount": 5,
  "organizationId": "org_xyz",
  "createdAt": "2026-02-11T00:00:00Z",
  "updatedAt": "2026-02-11T00:00:00Z"
}
```

`workflowCount` is computed at query time (count of workflows with this `projectId`).

## MCP Integration

The KeeperHub MCP `create_workflow` and `update_workflow` tools should accept an optional `projectId` parameter. This allows AI-driven workflow creation (like the ESM batch) to assign workflows to a project at creation time.

Add a `list_projects` MCP tool so the AI can discover existing projects before assigning.

## UI

### Workflows page (primary change)

**Sidebar (left rail):**
- "All Workflows" (default view, shows everything)
- List of projects, each showing name + color dot + workflow count badge
- "Uncategorized" entry at the bottom (workflows with no project)
- "+ New Project" button at the bottom of the sidebar

Clicking a project scopes the workflow list to only that project's workflows. Active project is highlighted.

**Workflow list (existing, minor changes):**
- When scoped to a project, show the project name as a heading above the list
- Each workflow card shows a small project color dot if it belongs to a project (only in "All" view)

### Project management

**Create project:** Inline form in the sidebar or a small modal. Just name + optional color picker. Keep it lightweight.

**Edit project:** Click a settings icon next to the project name in the sidebar. Opens a small popover or modal with name/description/color fields.

**Delete project:** Accessible from edit popover. Confirmation dialog: "This will ungroup X workflows. The workflows themselves won't be deleted."

### Assign workflow to project

**On workflow create/edit:** A project dropdown in the workflow settings panel (where name and description are edited). Shows existing projects + "None" + "New Project..." option.

**Bulk assign:** Multi-select workflows in the list view, then "Move to Project" action in a toolbar. Useful for organizing existing workflows after the feature ships.

### Empty states

- No projects yet: "Create a project to organize your workflows by protocol or operation."
- Project with no workflows: "No workflows in this project yet. Create one or move existing workflows here."

## Migration

1. Create `projects` table
2. Add nullable `projectId` column to `workflows` table
3. No data migration needed -- all existing workflows start as uncategorized

## Scope boundaries (what this does NOT include)

- No nested projects / hierarchy
- No shared projects across organizations
- No project-level permissions (inherits from org)
- No bulk enable/disable all workflows in a project (can be added later as an obvious next step)
- No project-level analytics or dashboards
- No drag-and-drop reordering of projects

## Future considerations

These are explicitly out of scope but worth noting as natural extensions:

- **Bulk operations:** Enable/disable all workflows in a project. Obvious v2 add-on -- a single API endpoint + a button.
- **Project templates:** Export a project (with all its workflow configs) as a template that can be deployed to another org. Makes the ESM monitoring suite shareable.
- **Project status:** Aggregate health indicator (X/Y workflows active, last execution status). Lightweight dashboard.
