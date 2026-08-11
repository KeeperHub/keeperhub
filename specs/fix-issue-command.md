# /fix-issue Command Spec

Automates the full Linear issue fix workflow -- from fetching issues to
creating a PR with Linear status updates. Designed for Pinpoint annotation
feedback and general Linear issues.

## Usage

```
/fix-issue --project UI          # Fix all open issues in the UI project
/fix-issue --issue KEEP-5        # Fix a single issue
/fix-issue --issue KEEP-5 --issue KEEP-8  # Fix specific issues
/fix-issue                       # List projects and prompt for selection
```

## Workflow Stages

### Stage 1: Intake

Fetch issue(s) from Linear via MCP. Parse Pinpoint annotations if present
(CSS selectors, feedback text, element positions, screenshots). Classify
each issue as UI or backend based on labels and description keywords.
Present a summary table to the user for confirmation before proceeding.

### Stage 2: Branch Setup

Stash any uncommitted changes. Pull latest staging and create a feature
branch derived from the issue context. Update each Linear issue status
to "In Progress".

### Stage 3: Research

Spawn parallel KeeperHub **researcher** agents -- one per issue. Each
agent locates the relevant files, understands the current code, and
proposes a minimal fix approach. Findings are compiled into a fix plan
presented to the user for confirmation.

### Stage 4: Implement

Detect UI issues and invoke `/frontend-design` skill before making
visual changes. Spawn parallel KeeperHub **builder** agents -- one per
issue or grouped by file to avoid conflicts. Run `pnpm check` and
`pnpm type-check` after all builds complete. Fix any failures and
re-run until both pass.

### Stage 5: Seed and Serve

Check if the dev server is running, start if not. Determine which seed
scripts are relevant based on affected pages and run them. Report test
credentials and page URLs to the user.

Page-to-seed mapping:

| Page | Seed Scripts |
|------|-------------|
| `/analytics` | `seed-user.ts`, `seed-analytics-data.ts` |
| `/hub` | `seed-user.ts`, `seed-test-workflow.ts` |
| `/workflows` | `seed-user.ts`, `seed-test-workflow.ts` |
| Other | `seed-user.ts` |

### Stage 6: Summary

For each issue, describe:

- **What changed** -- files modified, lines added/removed
- **Why** -- the root cause of the issue
- **Improvement** -- what the user will see differently

### Stage 7: UAT

Generate a UAT checklist per issue with page URLs, interaction steps,
and expected behavior. Walk through each item with the user. If browser
automation tools are available, offer to navigate and screenshot pages
for visual verification. Loop back to Stage 4 if any item fails.

### Stage 8: Ship

Stage relevant files, generate a commit message following the project's
commit-message skill, and invoke `/pr` to push and create the PR
targeting staging. After PR creation:

- Update each Linear issue status to "In Review"
- Add a comment to each issue with a brief fix summary and PR link
- Output the PR URL and a summary of all issues addressed

## Auto-detection: UI vs Backend

Issues are classified as UI when any of the following are present:

- Pinpoint annotations with CSS selectors or React component names
- Visual feedback keywords: "spacing", "flash", "overlap", "remove",
  "alignment", "color", "font", "layout", "responsive", "hover"
- Linear labels: "Design", "UI", "Frontend"

UI issues trigger the `/frontend-design` skill before implementation.

## Linear Integration

| Event | Linear Action |
|-------|--------------|
| Start fixing | Issue status -> "In Progress" |
| PR created | Issue status -> "In Review" |
| PR created | Comment added with fix summary + PR link |

## Prerequisites

- Linear MCP server connected (`mcp__linear-server__*` tools available)
- KeeperHub agent pipeline configured (researcher, builder agents)
- Local dev environment running (Docker, Postgres, Node)
