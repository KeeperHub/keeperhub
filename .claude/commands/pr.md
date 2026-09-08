---
description: Create a pull request for the current branch targeting staging
allowed-tools: Bash(git:*), Bash(gh:*), Read
---

<objective>
Create a pull request for the current branch against the staging base branch, with a well-crafted commit message and review requested from the keeperhub team.
</objective>

<context>
- Current branch: !`git branch --show-current`
- Git status: !`git status --short`
- Staged diff stat: !`git diff --cached --stat`
- Unstaged diff stat: !`git diff --stat`
- Commits ahead of staging: !`git log staging..HEAD --oneline`
- Full diff from staging: !`git diff staging...HEAD --stat`
</context>

<process>
1. Check for uncommitted changes (staged, unstaged, or untracked relevant files).
2. If the current branch IS staging:
   a. If there are uncommitted changes, infer a descriptive branch name from the
      changed files and diff content (e.g., `feature/update-pr-command`), create
      the branch with `git checkout -b feature/<name>`, then continue to step 3.
   b. If there are NO uncommitted changes, abort -- nothing to create a PR from.
3. If there are uncommitted changes, stage them and then read the file
   `.claude/skills/commit-message/SKILL.md` and follow its workflow to
   generate a commit message and run `git commit`. Do NOT write commit
   messages without reading the skill file first -- it contains the
   format rules and process to follow.
4. Push the current branch to origin if it has not been pushed yet or is behind.
5. Run `git log staging..HEAD --format="%B---"` to read all commit messages.
6. Derive the PR title and body from the commit messages -- especially the
   first (oldest) commit, which captures the original intent. The PR title
   is the commit summary prefixed with a conventional commit type
   (`feat:`, `fix:`, `chore:`, etc.) -- keep it under 70 characters.
7. Draft the PR body following these rules:
   - **Summary section**: The first bullet MUST be the intent sentence from
     the commit body -- the "why" this change exists. Additional bullets may
     add context, but never replace the intent with a list of files or
     features added.
   - **Test Plan section**: Bulleted checklist of how to verify the change.
   - **Self-check**: Re-read your summary. If it reads like a changelog or
     file inventory (e.g., "Add X", "Update Y", "Create Z"), rewrite it to
     explain why the change matters.

   Bad -- lists what changed without intent:
   ```
   ## Summary
   - Add `/commit` slash command that invokes the commit-message skill
   - Add `/pr` slash command to automate PR creation against staging
   - Add commit-message skill with format rules and workflow
   - Gitignore `.claude/worktrees/` directory
   ```

   Good -- leads with why, then adds context:
   ```
   ## Summary
   - Standardize commit and PR workflows into repeatable commands so
     messages follow consistent format rules and PRs always target
     staging with the right reviewers
   - Includes a commit-message skill that encodes the team's conventions
     so Claude follows them automatically
   ```
8. Create the PR targeting staging with review requested from the keeperhub team.
   Do NOT ask for confirmation -- proceed directly:
   `gh pr create --base staging --reviewer KeeperHub/keeperhub --title "..." --body "..."`
9. Output the PR URL.
</process>

<success_criteria>

- All changes committed before PR creation
- PR targets staging as base branch
- PR title follows conventional commit format
- Review requested from KeeperHub/keeperhub
- PR summary leads with intent (why), not a changelog of what changed
- PR URL returned to the user
  </success_criteria>
