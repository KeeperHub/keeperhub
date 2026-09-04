---
description: Fix Linear issues end-to-end -- fetch, research, implement, test, and PR
argument-hint: "[--project <name>] [--issue <KEEP-N>]"
---

<objective>
Fix one or more Linear issues from intake to PR. Fetches issue details from
Linear, researches the codebase, implements fixes (using /frontend-design for
UI work), seeds test data, walks through UAT, and creates a PR linked back to
Linear.

Examples:
- `/fix-issue --project UI` -- fix all open issues in the UI project
- `/fix-issue --issue KEEP-5` -- fix a single issue
- `/fix-issue --issue KEEP-5 --issue KEEP-8` -- fix specific issues
- `/fix-issue` -- list projects and prompt user to pick
</objective>

<context>
Project conventions: @CLAUDE.md
Current branch: !`git branch --show-current`
Git status: !`git status --short`
</context>

<process>

## Stage 1: Intake

1. Parse $ARGUMENTS for `--project` and `--issue` flags.
2. If `--issue` is provided, fetch each issue via `mcp__linear-server__get_issue`.
3. If `--project` is provided, fetch all open issues (status != Done, Canceled)
   from that project via `mcp__linear-server__list_issues` with
   `project: <name>` and `state: "Backlog"` then `state: "Todo"`.
4. If neither is provided, list projects via `mcp__linear-server__list_projects`
   and use AskUserQuestion to let the user pick a project or enter issue IDs.
5. For each issue, extract:
   - Issue ID and title
   - Feedback text (from Pinpoint annotations if present)
   - Page/component affected (from description selectors/URLs)
   - Whether it is a UI issue (check for CSS selectors, component names,
     visual feedback keywords like "spacing", "flash", "overlap", "remove")
6. Present a summary table of all issues to the user and ask for confirmation
   before proceeding.

## Stage 2: Branch Setup

1. Stash any uncommitted changes.
2. Switch to staging and pull latest: `git checkout staging && git pull origin staging`
3. Create a feature branch. Derive the name from the issues:
   - Single issue: `feature/keep-N-short-description`
   - Multiple issues from same project: `feature/<project>-fixes`
   - Mixed: `feature/linear-fixes`
4. Update each issue status to "In Progress" via `mcp__linear-server__save_issue`.

## Stage 3: Research

Spawn parallel KeeperHub **researcher** agents -- one per issue. Each agent
receives:
- The issue title and feedback text
- Any CSS selectors or component paths from Pinpoint annotations
- Instruction to find the exact file paths, line numbers, and surrounding code
- Instruction to propose a minimal fix approach

Wait for all researchers to complete. Compile findings into a fix plan and
present to the user for confirmation.

## Stage 4: Implement

1. Detect which issues are UI-related (from Stage 1 analysis).
2. For UI issues: invoke `/frontend-design` skill before making changes.
3. Spawn parallel KeeperHub **builder** agents -- one per issue (or group
   issues touching the same file into one agent). Each builder receives:
   - The research findings for its issue(s)
   - Explicit instruction to follow biome lint rules
   - Instruction to read files before editing
4. After all builders complete, run:
   ```
   pnpm check
   pnpm type-check
   ```
5. If either fails, read the error output and fix. Re-run until both pass.

## Stage 5: Seed and Serve

1. Check if the dev server is running on port 3000 (`lsof -ti:3000`).
   If not, start it with `pnpm dev` in the background.
2. Determine which seed scripts are relevant based on affected pages:
   - `/analytics` -> `scripts/seed/seed-user.ts`, `scripts/seed/seed-analytics-data.ts`
   - `/hub` -> `scripts/seed/seed-user.ts`, `scripts/seed/seed-test-workflow.ts`
   - `/workflows` -> `scripts/seed/seed-user.ts`, `scripts/seed/seed-test-workflow.ts`
   - Other -> `scripts/seed/seed-user.ts`
3. Run the relevant seed scripts. Use `--force` if data already exists.
4. Report the test credentials and URLs to the user.

## Stage 6: Summary

For each issue, describe:
- **What changed**: files modified, lines added/removed
- **Why**: the root cause of the issue
- **Improvement**: what the user will see differently

Present as a clear table.

## Stage 7: UAT

1. Generate a UAT checklist per issue:
   - Page URL to visit
   - What to look for (e.g., "no flash on load", "tags visible at bottom")
   - What to interact with (e.g., "hover over card", "click refresh")
   - Expected behavior
2. Present the checklist to the user.
3. Ask the user to verify each item. If browser automation tools are available
   (Playwright MCP or Claude-in-Chrome), offer to navigate and screenshot
   each page for visual verification.
4. If any item fails, loop back to Stage 4 to fix.
5. Once all items pass, proceed to Stage 8.

## Stage 8: Ship

1. Stage all changed files (only files relevant to the fixes, not unrelated
   changes). Never stage `.env`, credentials, or unrelated files.
2. Read `.claude/skills/commit-message/SKILL.md` and follow its workflow to
   generate a commit message and run `git commit`.
3. Invoke `/pr` to push and create the PR targeting staging.
4. After PR is created, for each fixed issue:
   a. Update status to "In Review" via `mcp__linear-server__save_issue`.
   b. Add a comment via `mcp__linear-server__save_comment` with:
      - Brief summary of the fix (2-3 sentences)
      - Link to the PR
5. Output the PR URL and a summary of all issues addressed.

</process>

<success_criteria>
- All target issues fetched from Linear and confirmed with user
- Feature branch created from latest staging
- All fixes pass pnpm check and pnpm type-check
- Dev server running with seeded test data
- UAT checklist generated and walked through with user
- PR created targeting staging with conventional commit title
- Linear issues updated to "In Review" with PR link and fix summary
- No unrelated files included in the commit
</success_criteria>
