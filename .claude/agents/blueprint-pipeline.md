<overview>
The Blueprint pipeline is the deterministic stage contract that governs all agent-mediated development work in KeeperHub. Every task flows through 5 sequential stages: DECOMPOSE, RESEARCH, IMPLEMENT, VERIFY, PR. Each stage has a defined owner, input contract, output contract, and error handling path.

This document is a reference specification -- not an agent. The Orchestrator reads this to understand how to coordinate worker agents through the pipeline. Worker agents reference it to understand their stage's expectations.
</overview>

<risk_tiers>
Every task entering the pipeline is classified into one of three risk tiers during DECOMPOSE. The tier determines autonomy level and human involvement.

**Tier 1 -- Full Auto**
- Pattern tasks following existing conventions
- Examples: add protocol definition, add plugin action step, add unit test, add webhook handler
- Pipeline runs end-to-end without human intervention
- PR can be auto-merged if CI passes

**Tier 2 -- Human Reviewed**
- New features, refactors, multi-file changes, API surface changes
- Examples: new plugin type, new API endpoint, UI component, workflow modification
- Pipeline runs end-to-end but PR requires human review before merge
- Human reviews PR diff and approves or requests changes

**Tier 3 -- Human Owned**
- Schema migrations, security code, Web3 transaction logic, auth changes, payment flows
- Examples: database migration, wallet signing logic, access control changes, credential handling
- Pipeline HALTS at DECOMPOSE and escalates to human immediately
- Human decides whether to proceed, modify scope, or handle manually

**Classification rules:**
- If the task modifies files in `lib/db/` or `drizzle/` (schema) -> Tier 3
- If the task modifies files touching private keys, signing, or transaction submission -> Tier 3
- If the task modifies auth middleware, session handling, or RBAC -> Tier 3
- If the task creates a new plugin/protocol following existing patterns -> Tier 1
- If the task adds tests for existing code -> Tier 1
- If the task creates new features or modifies existing behavior -> Tier 2
- When uncertain, classify as Tier 2 (human review provides safety net)

<tier_classification_protocol>
The Orchestrator MUST run this classification at DECOMPOSE before any work begins:

1. List all files the task will create or modify
2. Check each file path against these Tier 3 patterns:
   - lib/db/* or drizzle/* or **/migration* -> schema migration -> Tier 3
   - **signing* or **private-key* or **/wallet/* -> key management -> Tier 3
   - **/transaction* or **/transfer* (write operations, not read) -> tx submission -> Tier 3
   - lib/auth/* or middleware/auth* or **/session* -> auth/access control -> Tier 3
   - **/credentials* (creating new credential types, not using existing) -> credential handling -> Tier 3
3. If ANY file matches a Tier 3 pattern: classify as Tier 3
4. If the task creates a new plugin/protocol following existing patterns: Tier 1
5. If the task adds tests for existing code: Tier 1
6. Otherwise: Tier 2

When classifying, the Orchestrator MUST state:
- Which files were checked
- Which pattern (if any) matched
- The resulting tier
</tier_classification_protocol>
</risk_tiers>

<stages>

<stage name="DECOMPOSE" number="1">
**Owner:** Orchestrator (inline, not delegated)

**Input:**
- User task description (from slash command arguments or direct request)
- Project conventions from CLAUDE.md

**Process:**
1. Analyze the task to understand scope and intent
2. Classify risk tier (Tier 1, 2, or 3) using the classification rules above
3. If Tier 3: HALT immediately. Present task summary and risk justification to user. Do not proceed.
4. Break the task into concrete subtasks with file-level specificity
5. Identify research questions (patterns to discover, types to look up, conventions to verify)
6. Define success criteria that the Verifier will check

**Output -- Task Brief:**
```
TASK BRIEF
==========
Summary: [one-line task description]
Risk Tier: [1|2|3]
Tier Justification: [why this tier]

Subtasks:
1. [subtask description]
   Files: [file paths to create or modify]
2. [subtask description]
   Files: [file paths to create or modify]

Research Questions:
- [question about existing patterns, types, or conventions]
- [or "None" if pure pattern task with no unknowns]

Tests Required: [yes|no]
Test Files: [paths to test files to create or modify, or "N/A"]

Success Criteria:
- [criterion 1 -- must be verifiable by reading files or running commands]
- [criterion 2]
```

**Skip condition:** None. DECOMPOSE always runs.
**Error handling:** If task description is ambiguous, Orchestrator asks user for clarification before proceeding.
</stage>

<stage name="RESEARCH" number="2">
**Owner:** Researcher agent

**Input:**
- Research questions from the Task Brief
- File paths to examine from the Task Brief

**Process:**
1. For each research question, explore the codebase using Grep, Glob, and Read
2. Read referenced files to discover existing patterns and type signatures
3. Read scoped CLAUDE.md files in relevant directories for conventions
4. Trace import chains to understand module dependencies
5. Find the most similar existing implementation as a reference pattern
6. Record exact file paths and line numbers for all findings

**Output -- Research Report:**
```
RESEARCH REPORT
===============

Question 1: [question text]
Answer: [answer with specifics]
References:
- [file:line] - [what was found]
- [file:line] - [what was found]

Question 2: [question text]
Answer: [answer with specifics]
References:
- [file:line] - [what was found]

Patterns Discovered:
- [pattern name]: [description] (see [file:line])

Type Signatures Needed:
- [type/interface name] from [file] -- [relevant fields]

Reference Implementation: [file path] -- [why this is the best example to follow]

Recommended Approach: [synthesis of findings into implementation guidance]

Unresolved Questions:
- [question that could not be answered, if any]
```

**Skip condition:** If DECOMPOSE produces zero research questions (pure pattern task where all conventions are known), skip directly to IMPLEMENT. The Orchestrator decides whether to skip.
**Error handling:** If a research question cannot be answered from the codebase, include it in "Unresolved Questions" and let the Orchestrator decide whether to proceed or ask the user.
</stage>

<stage name="IMPLEMENT" number="3">
**Owner:** Builder agent

**Input:**
- Task Brief from DECOMPOSE
- Research Report from RESEARCH (if produced)

**Process:**
1. Read the Task Brief and research report
2. Read relevant existing code (referenced files, sibling implementations)
3. Read scoped CLAUDE.md files in the target directory
4. Create or modify files according to the brief's subtask list
5. Run `pnpm discover-plugins` if plugin or protocol files were created or modified
6. Run `pnpm check` (lint) -- if failures, read `.claude/lint-output.txt`, fix issues, re-run
7. Run `pnpm type-check` (TypeScript) -- if failures, read `.claude/typecheck-output.txt`, fix issues, re-run
8. Report results with exact file paths and check statuses

**Output -- Implementation Report:**
```
IMPLEMENTATION REPORT
=====================
Status: [PASS|FAIL]

Files Created:
- [path]: [description]

Files Modified:
- [path]: [description]

Lint: [PASS|FAIL]
Type Check: [PASS|FAIL]
Discover Plugins: [RAN|SKIPPED] [result if ran]

Issues (if FAIL):
- [issue description with file:line reference]

Deviations:
- [any files created/modified outside the brief's list, with justification]
```

**Iteration:** If lint or type-check fails, Builder fixes and re-runs (up to 2 rounds). After 2 failures on the same issue, Builder reports FAIL and the Orchestrator routes to Debugger.
**Error handling:** Builder NEVER creates PRs or branches. Builder reports exact failure details so the Orchestrator can route appropriately.
</stage>

<stage name="VERIFY" number="4">
**Owner:** Verifier agent

**Input:**
- List of files created/modified from IMPLEMENT
- Original Task Brief from DECOMPOSE (including success criteria)

**Process:**
1. Read all created and modified files
2. Check each file follows KeeperHub conventions (proper imports, no emojis, "use step" compliance)
3. Run automated checks:
   - `pnpm check` -- lint must pass
   - `pnpm type-check` -- TypeScript must pass
   - `pnpm vitest run [relevant-test-files]` -- unit tests must pass (if test files exist)
4. Validate each success criterion from the Task Brief
5. Check for regressions (TODO/FIXME markers, unrelated file modifications)
6. Produce verdict: APPROVED or REJECTED

**Output -- Verification Report:**
```
VERIFICATION REPORT
===================
APPROVED: [true|false]

Automated Checks:
- Lint (pnpm check): [PASS|FAIL]
- Type Check (pnpm type-check): [PASS|FAIL]
- Unit Tests: [PASS|FAIL|NO_TESTS] [details]
- Build (pnpm build): [PASS|FAIL]

Success Criteria:
1. [criterion text]: [PASS|FAIL] [evidence]
2. [criterion text]: [PASS|FAIL] [evidence]

Convention Compliance:
- Directory structure: [PASS|FAIL]
- "use step" patterns: [PASS|FAIL|N/A]
- No emojis: [PASS|FAIL]
- No debug artifacts: [PASS|FAIL]
- Plugin registration: [PASS|FAIL|N/A]

Issues Found:
- [issue description with file:line reference]

Recommendation: [APPROVE and proceed to PR | REJECT with fixes needed]
```

**Gate:** If APPROVED is false, Orchestrator routes failure details back to Builder (or Debugger for test/build failures). Maximum 2 verify-implement loops before escalating to human.
**Error handling:** Verifier NEVER modifies files. If a success criterion cannot be verified automatically, mark it as MANUAL_REVIEW_NEEDED and include in the report.
</stage>

<stage name="PR" number="5">
**Owner:** Orchestrator (inline, not delegated)

**Precondition:** VERIFY returned APPROVED: true

**Input:**
- Verified file list from IMPLEMENT
- Task Brief from DECOMPOSE (summary, risk tier, success criteria)
- Verification Report from VERIFY

**Process:**
1. Create a git branch following naming convention: `feature/description-in-kebab-case`
2. Stage all created/modified files (individually, never `git add .`)
3. Commit with conventional commit format: `{type}: {description}`
4. Run `pnpm build` as final gate -- must pass before PR creation
5. Push branch and create PR targeting `staging` branch
6. PR title follows conventional commit format
7. PR body includes: summary, files modified, risk tier, test results, verification status

**Output:**
- PR URL
- Branch name
- Commit hash

**Gate by risk tier:**
- Tier 1: PR created. Can be auto-merged if CI passes.
- Tier 2: PR created. Human review required before merge.
- Tier 3: Pipeline already halted at DECOMPOSE. This stage is never reached for Tier 3 tasks.

**Error handling:** If `pnpm build` fails at this stage, route back to Builder/Debugger for fix. Do not create PR with failing build.
</stage>

</stages>

<error_handling>
**Escalation chain:**

```
Builder fails (2 rounds)
  -> Orchestrator invokes Debugger with failure details
    -> Debugger investigates and fixes
      -> Builder re-verifies (lint, type-check)
        -> If still failing: Debugger gets one more attempt
          -> If Debugger fails: Escalate to human (SAFE-02 limit reached)

Verifier rejects (APPROVED: false)
  -> Orchestrator routes rejection details to Builder
    -> Builder fixes issues
      -> Verifier re-verifies
        -> If rejected again: Escalate to human (SAFE-02 limit reached)

Build fails at PR stage
  -> Route to Builder/Debugger
    -> Fix and re-run build
      -> If still failing: Escalate to human (SAFE-02 limit reached)
```

**Maximum iteration limits:**
- Builder lint/type-check fix attempts: 2 per issue
- Verify-implement loops: 2
- Debugger fix attempts: 2
- Build fix attempts at PR stage: 1
- All limits enforced by SAFE-02. When any limit is reached, the escalation protocol in SAFE-02 takes effect.

**Escalation to human includes:**
- Safeguard that triggered the escalation (SAFE-01, SAFE-02, SAFE-03, or SAFE-04)
- Original task description
- Risk tier and justification
- All error messages and stack traces
- Files involved
- What was attempted and why it failed
- Recommended manual action
</error_handling>

<state_format>
Each stage produces a structured output (shown above) that becomes the next stage's input. State is passed as plain text between agents for readability and debuggability.

**State flow:**
```
User Request
  -> [DECOMPOSE] -> Task Brief
    -> [RESEARCH] -> Research Report (or skipped)
      -> [IMPLEMENT] -> Implementation Report
        -> [VERIFY] -> Verification Report
          -> [PR] -> PR URL
```

All intermediate state is ephemeral -- it exists only in the agent conversation context. The permanent artifacts are the code changes and the PR.

**No parallel execution in v1.4:** Stages run strictly sequentially. One stage must complete before the next begins. Parallel agent execution within stages is a future enhancement.
</state_format>

<safeguards>
These safeguards are ACTIVE and ENFORCED. Every agent MUST follow them. They are not aspirational -- they are binding pipeline rules.

<safeguard id="SAFE-01" name="Human Review Gate">
**Trigger:** Task classified as Tier 3 during DECOMPOSE
**Protocol:**
1. Orchestrator completes risk classification using <tier_classification_protocol>
2. If Tier 3: Orchestrator HALTS the pipeline immediately
3. Orchestrator presents to the user:
   - Task summary
   - Risk tier: 3
   - Tier justification (which files matched which Tier 3 pattern)
   - Recommendation: "This task modifies [category]. Proceed manually or approve agent execution with human review."
4. Pipeline does NOT proceed unless the user explicitly approves in chat
5. If user approves: pipeline continues but PR is marked as requiring human review before merge
6. If user declines: pipeline terminates gracefully with no changes
**Output:** HALT message to user with classification details
</safeguard>

<safeguard id="SAFE-02" name="Iteration Limit">
**Trigger:** Any implement-verify or fix-verify cycle
**Protocol:**
1. Orchestrator maintains a counter for each cycle type:
   - Builder lint/type-check fix rounds: max 2
   - Verify-implement loops: max 2
   - Debugger fix attempts: max 2
   - Build fix attempts at PR stage: max 1
2. On each iteration, Orchestrator increments the relevant counter
3. When a counter reaches its limit:
   a. Orchestrator STOPS retrying immediately
   b. Orchestrator compiles an escalation report containing:
      - Original task description
      - Risk tier and justification
      - All error messages from each failed attempt
      - Files involved
      - What was attempted and why it failed
      - Recommended manual action
   c. Orchestrator presents the escalation report to the user
   d. Pipeline terminates -- no PR is created
4. Counters reset only when starting a completely new pipeline run
**Output:** Escalation report to user after limit reached
</safeguard>

<safeguard id="SAFE-03" name="Build Verification Gate">
**Trigger:** Before PR creation (PR stage, step 4)
**Protocol:**
1. Orchestrator runs `pnpm build` as the final gate before creating a PR
2. This is mandatory even if the Verifier already ran build during VERIFY
3. If build PASSES: proceed with PR creation
4. If build FAILS:
   a. Route to Builder (or Debugger if Builder already failed) for fix attempt
   b. Re-run build after fix
   c. If build still fails: invoke SAFE-02 (iteration limit) -- this counts as a fix attempt
5. Build must produce exit code 0. Any non-zero exit code is a failure.
6. Common build failures to watch for:
   - "use step" bundler violations (exported functions from step files)
   - Missing imports or type errors not caught by type-check alone
   - Runtime-only dependency resolution failures
**Output:** Build PASS/FAIL status, included in PR description
</safeguard>

<safeguard id="SAFE-04" name="Verifier Approval Gate">
**Trigger:** VERIFY stage completion
**Protocol:**
1. Verifier produces a Verification Report with `APPROVED: true` or `APPROVED: false`
2. Orchestrator reads the APPROVED field as a boolean gate:
   - `APPROVED: true` -> proceed to PR stage
   - `APPROVED: false` -> route rejection to Builder for fixes, then re-verify
3. The Orchestrator MUST NOT proceed to PR stage without `APPROVED: true`
4. If the Verifier report is malformed (missing APPROVED field, ambiguous wording):
   - Orchestrator re-invokes Verifier with clarification request
   - Maximum 1 retry for malformed reports
   - If still malformed: escalate to human
5. The Verification Report is included in the PR description as evidence of review
**Output:** APPROVED boolean, Verification Report text
</safeguard>

<safeguard_interaction>
Safeguards can interact:
- SAFE-01 fires at DECOMPOSE -> if halted, no other safeguards are relevant
- SAFE-04 fires at VERIFY -> if rejected, SAFE-02 counter increments for the verify-implement loop
- SAFE-02 fires when any counter reaches limit -> terminates pipeline regardless of stage
- SAFE-03 fires at PR stage -> if build fails and fix fails, SAFE-02 terminates pipeline
</safeguard_interaction>
</safeguards>
