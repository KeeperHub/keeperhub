---
description: Implement a KeeperHub feature via the agent pipeline
argument-hint: <feature-description>
---

<objective>
Implement a KeeperHub feature using the Blueprint agent pipeline. $ARGUMENTS is a free-form description of what to build, for example:
- "Add a webhook trigger that fires when a workflow execution fails"
- "Add a gas price condition step that checks current gas against a threshold"
- "Refactor the protocol detail page to show action inputs inline"
- "Add pagination to the Hub protocols grid"

This command invokes the Orchestrator agent which runs the Blueprint pipeline: DECOMPOSE -> RESEARCH -> IMPLEMENT -> VERIFY -> PR.

Important: Features touching database schemas (lib/db/, drizzle/), security code (auth middleware, session handling), Web3 transaction signing (wallet, private keys), or credential handling are Tier 3. The Orchestrator enforces SAFE-01: it halts the pipeline at DECOMPOSE, presents the risk classification with file-path evidence, and waits for your explicit approval before proceeding.
</objective>

<context>
Project conventions: @CLAUDE.md
Tech stack and structure: @.planning/ROADMAP.md
Blueprint pipeline: @.claude/agents/blueprint-pipeline.md
Existing plugins: !`ls plugins/`
Existing protocols: !`ls protocols/`
</context>

<process>
Spawn the Orchestrator agent with the following task description:

```
Feature Task: $ARGUMENTS

Pipeline: Blueprint (DECOMPOSE -> RESEARCH -> IMPLEMENT -> VERIFY -> PR)

Project context the Orchestrator MUST read before DECOMPOSE:
- @CLAUDE.md -- all project conventions, lint rules, file ownership rules
- @.claude/agents/blueprint-pipeline.md -- pipeline stage contracts and risk tier rules

Risk classification guidance:
- Tier 1 (full-auto): New step in existing plugin, new test, small UI change, helper utility
- Tier 2 (human-reviewed): New API endpoint, new UI component, multi-file refactor, new plugin type, new workflow feature
- Tier 3 (HALT): Schema migrations (any file in lib/db/ or drizzle/), security/auth middleware, wallet signing/transaction submission, credential handling

KeeperHub conventions for the Orchestrator to enforce:
- Plugins go in plugins/, protocols go in protocols/
- "use step" bundler constraints: step files NEVER export functions (only step fn + _integrationType + type exports). Violations break the production build.
- Shared step logic goes in *-core.ts files without "use step"
- Run pnpm discover-plugins after any plugin or protocol changes
- Run pnpm check (lint) and pnpm type-check before committing
- No emojis in code, comments, documentation, or PR descriptions
- Branch naming: feature/description-in-kebab-case (no task codes)
- PR titles: conventional commit format (feat:, fix:, refactor:, etc.)
- Target branch: staging (always)

Research guidance for the Researcher agent:
- Explore the codebase to find the right directory for new code
- Find the most similar existing implementation as a pattern reference
- Identify all files that need to be created or modified
- Check for TypeScript types/interfaces needed in the new code
- Verify the feature does not conflict with existing implementations

Success criteria (the Orchestrator must define these in DECOMPOSE):
- All new/modified files pass pnpm check and pnpm type-check
- If plugin or protocol files were created/modified: pnpm discover-plugins ran without errors
- If tests were required: pnpm vitest run passes on the relevant test files
- Feature behaves as described in $ARGUMENTS
- No regressions in existing functionality (Verifier checks this)
- PR created targeting staging branch
```

The Orchestrator handles: risk classification, task decomposition, research delegation, implementation, verification, and PR creation.
</process>

<success_criteria>
- Orchestrator pipeline completes end-to-end for Tier 1 and Tier 2 features
- For Tier 3 features: Orchestrator halts at DECOMPOSE and presents the task with risk justification
- All automated checks pass: pnpm check, pnpm type-check, vitest (where applicable)
- PR created targeting staging branch with conventional commit title
- Verifier agent explicitly approved before PR creation (SAFE-04 gate)
- Pipeline safeguards enforced: risk tier classified (SAFE-01), iteration limits tracked (SAFE-02), build verified (SAFE-03)
- For Tier 3 features: Orchestrator halted at DECOMPOSE with classification details (SAFE-01)
</success_criteria>
