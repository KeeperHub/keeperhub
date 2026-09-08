---
description: Configure standard GitHub repo settings (branch rules, security, team access)
arguments:
  - name: repo
    description: "org/repo (e.g., KeeperHub/new-repo)"
    required: true
---

Configure the GitHub repository `$ARGUMENTS` with KeeperHub's standard settings. This must be **idempotent** -- safe to run multiple times. Check each setting before changing it, and report what was already correct vs what was configured.

No hardcoded IDs or values -- look up everything dynamically at runtime.

## Steps

### 1. Validate Access & Parse Arguments

Parse org and repo from `$ARGUMENTS` (format: `org/repo`). If not in that format, ask the user.

Run `gh repo view $ARGUMENTS --json name,owner` to verify the repo exists and you have access. If it fails, stop and report the error.

Extract the org name from the argument (everything before the `/`).

### 2. Check & Configure Repo Settings

Run `gh repo view $ARGUMENTS --json deleteBranchOnMerge,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,hasWikiEnabled,hasDiscussionsEnabled` to get current settings.

Compare each setting against the target state. Only apply what needs changing using `gh repo edit`. Build a single `gh repo edit` call with only the flags that need changing. If nothing needs changing, skip entirely.

Target state:
- `deleteBranchOnMerge`: true (`--delete-branch-on-merge`)
- `squashMergeAllowed`: true (`--enable-squash-merge`)
- `mergeCommitAllowed`: true (`--enable-merge-commit`)
- `rebaseMergeAllowed`: true (`--enable-rebase-merge`)
- `hasWikiEnabled`: false (`--enable-wiki=false`)
- `hasDiscussionsEnabled`: false (`--enable-discussions=false`)

Always run (not queryable via JSON):
```bash
gh repo edit $ARGUMENTS --allow-update-branch
```

Report each setting individually: "Already correct" or "Configured".

### 3. Check & Configure Security

Check current security settings first:
```bash
gh api repos/$ARGUMENTS --jq '.security_and_analysis'
```

Then apply what's needed. These are all idempotent (safe to repeat):

**Secret scanning + push protection:**
```bash
gh repo edit $ARGUMENTS --enable-secret-scanning --enable-secret-scanning-push-protection
```

**Dependabot vulnerability alerts:**
```bash
gh api repos/$ARGUMENTS/vulnerability-alerts -X PUT
```

**Dependabot security updates:**
```bash
gh api repos/$ARGUMENTS/automated-security-fixes -X PUT
```

Check Dependabot security updates status after enabling:
```bash
gh api repos/$ARGUMENTS/automated-security-fixes --jq '.enabled'
```

Report status for each.

### 4. Check & Configure Team Access

Look up the org's teams and find a team with the same slug as the org name (lowercase). For example, for org `KeeperHub`, look for team `keeperhub`:

```bash
ORG=$(echo "$ARGUMENTS" | cut -d'/' -f1)
TEAM_SLUG=$(echo "$ORG" | tr '[:upper:]' '[:lower:]')
```

Check if the team exists:
```bash
gh api orgs/$ORG/teams/$TEAM_SLUG --jq '.id'
```

If the team exists, check current repo access:
```bash
gh api repos/$ARGUMENTS/teams --jq '.[] | select(.slug=="'$TEAM_SLUG'") | .permission'
```

If permission is already `push`, report "Already correct".
If not set or different, configure it:
```bash
gh api orgs/$ORG/teams/$TEAM_SLUG/repos/$ARGUMENTS -X PUT -f permission=push
```

If the team doesn't exist, report it and skip this step.

### 5. Check & Configure Branch Ruleset

**Smart idempotency check.** Don't just match by name -- check if ANY existing ruleset already covers `staging` and `prod` branches with the required rules.

List existing rulesets with full details:
```bash
gh api repos/$ARGUMENTS/rulesets
```

For each ruleset, check if it:
1. Targets branches including both `refs/heads/staging` and `refs/heads/prod`
2. Has rules including `deletion`, `non_fast_forward`, `pull_request`, and `required_status_checks`

If a matching ruleset already exists (regardless of name), report "Already exists: [ruleset name]" and **skip creation**.

If no matching ruleset exists, look up the team ID dynamically:
```bash
TEAM_ID=$(gh api orgs/$ORG/teams/$TEAM_SLUG --jq '.id')
```

Then create the ruleset with the following JSON body via `gh api repos/$ARGUMENTS/rulesets -X POST --input -`:

```json
{
  "name": "branch-protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/staging", "refs/heads/prod"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "lint-typecheck" },
          { "context": "build-test" },
          { "context": "check-title" }
        ]
      }
    }
  ],
  "bypass_actors": [
    { "actor_id": TEAM_ID, "actor_type": "Team", "bypass_mode": "pull_request" }
  ]
}
```

Replace `TEAM_ID` with the dynamically looked-up value (integer, not string). Use heredoc or build JSON with the value substituted.

### 6. Check & Configure Dependabot Version Updates

Check if `.github/dependabot.yml` already exists in the repo:
```bash
gh api repos/$ARGUMENTS/contents/.github/dependabot.yml --jq '.name' 2>/dev/null
```

If the file already exists, report "Already exists" and **skip creation**.

If it does NOT exist, detect the repo's default branch:
```bash
DEFAULT_BRANCH=$(gh repo view $ARGUMENTS --json defaultBranchRef --jq '.defaultBranchRef.name')
```

Then create the file via the GitHub API. The config should:
- Target `npm` ecosystem: weekly on Monday, grouped minor+patch, ignore major versions, limit 5 open PRs
- Target `github-actions` ecosystem: monthly
- Both target the detected default branch
- Label PRs with `dependencies`

```bash
gh api repos/$ARGUMENTS/contents/.github/dependabot.yml -X PUT \
  -f message="chore: add dependabot config" \
  -f branch="$DEFAULT_BRANCH" \
  -f content="$(echo 'version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    target-branch: "DEFAULT_BRANCH_PLACEHOLDER"
    open-pull-requests-limit: 5
    groups:
      minor-and-patch:
        update-types:
          - "minor"
          - "patch"
    ignore:
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
    labels:
      - "dependencies"

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "monthly"
    target-branch: "DEFAULT_BRANCH_PLACEHOLDER"
    labels:
      - "dependencies"' | sed "s/DEFAULT_BRANCH_PLACEHOLDER/$DEFAULT_BRANCH/g" | base64)"
```

Replace `DEFAULT_BRANCH_PLACEHOLDER` with the actual detected default branch name before base64 encoding.

### 7. Configure Actions Permissions

Set fork workflow approval and actions permissions:
```bash
gh api repos/$ARGUMENTS/actions/permissions -X PUT -f allowed_actions=all -F enabled=true
```

### 8. Report Summary

Print a clear summary table:

```
Repository: $ARGUMENTS

Setting                          | Status
---------------------------------|------------------
Auto-delete branches             | [status]
Squash merge                     | [status]
Merge commit                     | [status]
Rebase merge                     | [status]
Wiki disabled                    | [status]
Discussions disabled             | [status]
Allow update branch              | Configured (not queryable)
Secret scanning                  | [status]
Push protection                  | [status]
Dependabot alerts                | [status]
Dependabot security updates      | [status]
Dependabot version updates       | [status]
Team access ([slug]: write)      | [status]
Branch ruleset (staging + prod)  | [status]
Actions permissions              | [status]
```

Where each `[status]` is one of:
- "Already correct" -- setting was already at target state
- "Configured" -- setting was changed to target state
- "Already exists: [name]" -- for rulesets that match
- "Skipped ([reason])" -- e.g., team not found
- "Failed: [error message]" -- something went wrong

## Error Handling

- If any step fails, report the error but **continue** with remaining steps
- Never create duplicate rulesets -- check by branch coverage and rule types, not just name
- Never hardcode team IDs, user IDs, or org-specific values
- All PUT API calls are naturally idempotent
- `gh repo edit` flags are idempotent (setting an already-set value is a no-op)
- If `gh` CLI is not installed or not authenticated, fail immediately with a clear message
