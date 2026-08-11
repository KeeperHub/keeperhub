---
description: Add a new plugin to KeeperHub via the agent pipeline
argument-hint: <plugin-name> [description]
---

<objective>
Add a new KeeperHub workflow plugin. $ARGUMENTS is either:
- A plugin name and optional description (e.g., "telegram Send message to Telegram channels") -- pipeline creates the plugin
- Just a plugin name (e.g., "coinbase") -- pipeline will ask for details
- Empty -- pipeline will ask what plugin to build

This command invokes the Orchestrator agent which runs the full Blueprint pipeline: DECOMPOSE -> RESEARCH -> IMPLEMENT -> VERIFY -> PR. The pipeline produces a complete, lint-clean plugin in `plugins/` with step files, icon, credentials (if needed), and documentation.
</objective>

<context>
Domain knowledge: @.claude/agents/plugin-domain.md
Example credential plugin: @plugins/discord/index.ts
Example system plugin: @plugins/web3/index.ts
Plugin registry: @plugins/registry.ts
Project conventions: @CLAUDE.md
Blueprint pipeline: @.claude/agents/blueprint-pipeline.md
Existing plugins: !`ls plugins/`
</context>

<process>
Spawn the Orchestrator agent with the following task description:

```
Plugin Task: Add plugin "$ARGUMENTS" to KeeperHub

Domain Reference: .claude/agents/plugin-domain.md

Task Type: Plugin creation (Tier 1 for new plugin following existing patterns, Tier 2 if novel plugin type)

Orchestrator: Before spawning agents, determine:
1. Plugin variant: credential-based (external API), system (pure logic), or infrastructure (uses web3 infra)?
   - If it shares infrastructure with an existing plugin (e.g., new web3 action), add it as a new action on that plugin instead of creating a new one
2. Is this security-critical? (maxRetries = 0 needed)
3. What actions does this plugin need?

Required artifacts for a NEW plugin:
- plugins/{name}/index.ts -- plugin definition
- plugins/{name}/icon.tsx -- SVG icon
- plugins/{name}/credentials.ts -- credential type (if credential-based)
- plugins/{name}/test.ts -- connection test
- plugins/{name}/steps/{action-slug}.ts -- one per action
- docs/plugins/{name}.md -- documentation page

Required artifacts for an ACTION ADDITION to an existing plugin:
- plugins/{existing-plugin}/steps/{action-slug}.ts -- new step file
- plugins/{existing-plugin}/index.ts -- add action entry to actions array

Required modifications (both cases):
- docs/plugins/_meta.json -- add/update nav entry
- docs/plugins/overview.md -- add/update Available Plugins table
- (auto-generated) plugins/index.ts
- (auto-generated) lib/step-registry.ts

Research questions for the Researcher agent:
- Does a similar plugin already exist (check plugins/)?
- Should this be a new plugin or a new action on an existing plugin?
- What does the API for this service look like (authentication, endpoints)?
- What patterns does the most similar existing plugin use?
- Does the plugin type slug already exist in lib/types/integration.ts?

Success criteria:
- pnpm discover-plugins runs without errors and registers the plugin
- pnpm check passes with zero lint errors
- pnpm type-check passes with zero TypeScript errors
- Step files have "use step" directive and no exported functions (only step fn + _integrationType + types)
- Documentation page exists with actions table and per-action sections
```

The Orchestrator handles: determining plugin variant, decomposing subtasks, delegating to Researcher/Builder/Verifier agents, and creating the PR.
</process>

<success_criteria>
- Orchestrator pipeline completes end-to-end
- Plugin directory exists at plugins/{name}/ with all required files
- All checks pass: pnpm check, pnpm type-check, pnpm discover-plugins
- PR created targeting staging branch with conventional commit format
- Verifier agent explicitly approved before PR creation (SAFE-04 gate)
- Pipeline safeguards enforced: risk tier classified (SAFE-01), iteration limits tracked (SAFE-02), build verified (SAFE-03)
- For Tier 3 changes (if plugin touches transaction signing or credentials): Orchestrator halted at DECOMPOSE with classification details (SAFE-01)
</success_criteria>
