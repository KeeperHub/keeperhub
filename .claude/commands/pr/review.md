---
allowed-tools: Bash(gh issue view:*), Bash(gh search:*), Bash(gh issue list:*), Bash(gh pr diff:*), Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh api:*)
description: Code review a pull request
argument-hint: [pr-number]
disable-model-invocation: false
---

Provide a code review for the given pull request.

To do this, follow these steps precisely:

## Step 1: Intake (all 3 in parallel)

Launch these 3 Haiku agents in a SINGLE parallel batch:

a. **Eligibility**: Check if the PR (a) is closed, (b) is a draft, (c) does not
   need a code review (automated or trivially simple), or (d) already has a code
   review from you. If so, report ineligible.

b. **CLAUDE.md discovery**: Find the root CLAUDE.md and any CLAUDE.md files in
   the directories of changed files. Return file paths only, not contents.

c. **PR summary**: View the PR and return title, description, changed files, and
   a brief summary of the change.

If the eligibility check reports ineligible, stop.

## Step 2: Review (all 5 in parallel)

Launch these 5 agents in a SINGLE parallel batch. Each should return a list of
issues with file path, line context, and reason (CLAUDE.md adherence, bug,
historical context, etc.):

a. **CLAUDE.md compliance** (Sonnet): Audit the diff against CLAUDE.md rules.
   Only flag violations in lines the PR actually changed or added. Not all
   CLAUDE.md instructions apply during review -- focus on code quality rules,
   not workflow instructions.

b. **Bug scan** (Sonnet): Read the diff and do a shallow scan for obvious bugs.
   Focus ONLY on the changed lines. Look for logic errors, missing null checks,
   race conditions, wrong variable references, missing cleanup. Ignore nitpicks,
   style issues, and anything a linter would catch. Ignore likely false
   positives.

c. **Git history context** (Sonnet): Run `gh pr diff $PR --name-only` to get
   changed files. For each file, run `git log --oneline -5 -- <file>` to check
   recent history. ONLY blame specific lines that were changed or removed (use
   `git log -1 --format="%H %s" -L <start>,<end>:<file>` for targeted ranges).
   Do NOT blame entire files. Limit to 20 total git commands. Look for: code
   removed that was recently added for a reason, or changes that contradict the
   intent of recent commits.

d. **Previous PR comments** (Sonnet): Run `gh pr diff $PR --name-only` to get
   changed files. Find the 5 most recent merged PRs that touched these files
   using `git log --oneline -5 -- <file>`. For each, check for inline review
   comments using `gh api repos/{owner}/{repo}/pulls/{number}/comments`. Limit
   to 10 total API calls. Only flag comments that directly apply to the current
   changes.

e. **Code comment compliance** (Haiku -- this is simpler analysis): Read the
   changed files and check if the PR's modifications contradict any code
   comments, TODOs, or JSDoc in those files. Only flag direct contradictions,
   not missing documentation.

## Step 3: Score (parallel, skip empties)

For each issue found in Step 2, launch a parallel Haiku agent to score
confidence (0-100). Skip agents that reported no issues.

Give each scoring agent this rubric verbatim:

- 0: Not confident at all. False positive that doesn't stand up to light
  scrutiny, or is a pre-existing issue.
- 25: Somewhat confident. Might be real, might be false positive. If stylistic,
  not explicitly called out in the relevant CLAUDE.md.
- 50: Moderately confident. Verified real issue, but a nitpick or unlikely in
  practice. Not very important relative to the rest of the PR.
- 75: Highly confident. Double-checked and very likely a real issue that will be
  hit in practice. The existing PR approach is insufficient. Directly impacts
  functionality, or directly mentioned in the relevant CLAUDE.md.
- 100: Absolutely certain. Confirmed real issue that will happen frequently.
  Evidence directly confirms this.

For CLAUDE.md issues, the agent must verify the CLAUDE.md actually calls out
that specific issue.

## Step 4: Filter and report

Filter out issues scoring below 80.

Report the findings directly to the user in the terminal using the comment format below. Do NOT post a comment to the PR -- just display the results.

## False positive examples (for Steps 2 and 3)

- Pre-existing issues on lines the PR did not modify
- Something that looks like a bug but is not actually a bug
- Pedantic nitpicks a senior engineer wouldn't call out
- Issues a linter, typechecker, or compiler would catch (imports, types,
  formatting). Assume CI runs these separately.
- General code quality (test coverage, docs) unless required by CLAUDE.md
- CLAUDE.md issues explicitly silenced by lint ignore comments
- Functionality changes that are intentional or directly related to the PR's
  broader goal

## Notes

- Do not build, typecheck, or lint. CI handles these separately.
- Use `gh` for all GitHub interaction, not web fetch.
- If $ARGUMENTS is provided, use it as the PR number. Otherwise, detect from
  current branch: `gh pr list --head $(git branch --show-current) --json number --jq '.[0].number'`
- You MUST cite and link each issue found.

## Comment format

If issues found (example with 3):

```
### Code review

Found 3 issues:

1. <brief description> (CLAUDE.md says "<...>")

<link to file with full sha1 + line range>

2. <brief description> (bug due to <context>)

<link to file with full sha1 + line range>

3. <brief description> (historical context: <...>)

<link to file with full sha1 + line range>
```

If no issues:

```
### Code review

No issues found. Checked for bugs and CLAUDE.md compliance.
```

Link format (must use full sha, not HEAD or branch name):
`https://github.com/{owner}/{repo}/blob/{full-sha}/{path}#L{start}-L{end}`

Provide at least 1 line of context before and after (e.g., commenting about
lines 5-6, link to L4-L7).
