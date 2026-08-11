---
description: Cut a release PR from staging to prod with auto-generated description
allowed-tools: Bash(git:*), Bash(gh:*), Write, Read
---

<objective>
Open a release PR that promotes every merged PR currently on `staging` to `prod`, with a structured description that enumerates the PRs, flags any risky changes, and includes a post-deploy verification checklist.
</objective>

<context>
- Current branch: !`git branch --show-current`
- Git status: !`git status --short`
- Commits in staging not yet in prod (merges only): !`git log --merges --first-parent origin/prod..origin/staging --pretty="%h %s" 2>/dev/null`
- All commits in staging not yet in prod: !`git log --first-parent origin/prod..origin/staging --pretty="%h %s" 2>/dev/null`
</context>

<process>
1. **Abort if the working tree is dirty.** A release PR only promotes what is
   already on `origin/staging`. If there are uncommitted or unstaged changes,
   print a clear message and tell the user to commit or stash first, then exit.
2. **Fetch the latest refs.** Run `git fetch origin staging prod` so local refs
   are current before diffing.
3. **Enumerate the promotion set.** Run:
   `git log --merges --first-parent origin/prod..origin/staging --pretty="%h %s"`
   to list the merge commits that will be promoted. Parse each subject line
   for a `Merge pull request #<N>` token and capture the PR number. If there
   are zero merges, abort -- tell the user there is nothing to release.
4. **Fetch each PR's real title** via
   `gh pr view <N> --json number,title -q '"#\(.number) \(.title)"'`
   so the description references the canonical PR title, not the branch name.
5. **Scan the diff for risk indicators.** Any of these produce a "Risk callouts"
   entry in the description; if all three come back empty, omit the section
   entirely:
   - **Database migrations** --
     `git diff origin/prod..origin/staging --stat -- drizzle/`
   - **Deploy values / secrets** --
     `git diff origin/prod..origin/staging --stat -- deploy/keeperhub-stack/`
   - **Dependency changes** --
     `git diff origin/prod..origin/staging --stat -- package.json pnpm-lock.yaml`
6. **Build the PR body** from the following template. Omit the "Risk callouts"
   subsection whenever it would be empty.

   ```markdown
   ## Summary

   Promote the following merged PRs from staging to prod:

   - #<N> <title>
   - #<N> <title>
   ...

   ## Risk callouts

   - **Database migrations**: <files or "none">
   - **Deploy values / secrets**: <files or "none">
   - **Dependency changes**: <files or "none">

   ## Post-deploy verification

   - [ ] `deploy-keeperhub` workflow finishes green
   - [ ] `curl -fsS https://app.keeperhub.com/api/health` returns 200
   - [ ] Smoke-test the surfaces affected by the merged PRs above
   - [ ] Watch Sentry / logs for ~10 minutes after the rollout
   ```

7. **Write the body to `/tmp/release-pr-body.md`** via the Write tool. Never
   inline the body in the `gh pr create` command -- heredoc escaping breaks
   on backticks inside code blocks.
8. **Create the PR** -- title is always literally `release: to prod` (matches
   the existing release convention; do not invent a new title). Do NOT ask
   for confirmation, proceed directly:
   `gh pr create --base prod --head staging --title "release: to prod" --body-file /tmp/release-pr-body.md`
9. **Output the PR URL.**
</process>

<success_criteria>

- PR targets `prod` with `staging` as head
- Title is exactly `release: to prod`
- Description enumerates every merged PR being promoted, with the PR number and real title (not the branch name)
- Any DB migrations, deploy/values changes, or dependency bumps are surfaced in "Risk callouts"; otherwise the section is omitted
- Post-deploy verification checklist is included
- Command aborts cleanly if there is nothing to release
- PR URL returned to the user
  </success_criteria>
