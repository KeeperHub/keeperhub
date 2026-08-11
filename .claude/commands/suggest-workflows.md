---
description: Analyze a protocol, contract, or case study to find automation gaps and suggest high-value KeeperHub workflows
argument-hint: <target> (protocol name, contract address, case study topic, or URL)
---

<objective>
Analyze $ARGUMENTS to find automation gaps and deliver maximum value to web3 protocol dev and ops teams through KeeperHub workflows.

The primary purpose is identifying where manual, fragile, or missing automations are costing the target time, money, or reliability -- then designing workflows that close those gaps. Where gaps reveal missing KeeperHub capabilities, propose the specific plugins needed so we can build them.

Existing workflows (balance watchers, fillers, poker, event listeners) are the foundation -- the primitives. Build upon them to create workflows that solve real operational problems.
</objective>

<context>

KeeperHub is the critical reliability layer for Web3 operations, protecting Sky Protocol (formerly MakerDAO) with zero downtime and ~30% gas savings. The platform provides no-code workflow automation for blockchain operations.

## Loading Current Platform Capabilities

**Step 1: Try MCP (source of truth)**
Use the `mcp__keeperhub__list_action_schemas` tool with `include_full_schemas: true` to get the current list of triggers, actions, and node structure. This is the authoritative source and reflects the latest platform capabilities.

**Step 2: If MCP is unavailable, use this fallback**

### Fallback Trigger Types
- Manual (on-demand), Schedule (cron), Webhook (HTTP), Event (blockchain event listener)

### Fallback Action Types
- **Web3**: `web3/check-balance`, `web3/check-token-balance`, `web3/transfer-funds`, `web3/transfer-token`, `web3/read-contract`, `web3/write-contract`
- **System**: `Condition` (gate logic), `HTTP Request` (external API calls), `Database Query` (state persistence -- user provides connection details)
- **Messaging**: `sendgrid/send-email`, `discord/send-message`
- **Webhook**: `webhook/send-webhook` (outbound HTTP)

### Existing Workflow Patterns (the basics -- already solved)
- **Watcher**: Schedule -> Check Balance -> Condition -> Notify
- **Filler**: Schedule -> Check Balance -> Condition -> Transfer + Notify
- **Poker**: Schedule -> Write Contract (execute function)
- **Events**: Event Listener -> Notify/Webhook
- **Contract Interaction**: Read -> Condition -> Write -> Verify -> Notify
- **Batch Distribution**: Schedule -> Multiple Transfers -> Notify

### Node/Edge Structure
Workflows are DAGs. Nodes have: id, type (trigger/action), label, config (with actionType). Nodes reference upstream outputs via `{{@node-id:Label.field}}` syntax. Edges connect source to target.

### Current Limitations (opportunities for new plugins)
- EVM only (no Solana, Arbitrum yet)
- No price feeds / oracle data natively
- No cross-chain operations
- No loops or recursion in workflows
- No human-in-the-loop approval nodes
- No AI/LLM reasoning nodes
- No DeFi-protocol-specific integrations (Aave, Uniswap, etc.)

## Production Reference (Sky Protocol)
12 wallet watchers, MegaPoker hourly poke(), 3 Safe multisig event watchers, Trustless Manifesto event listener. These are table stakes -- go beyond them.
</context>

<process>

1. **Load current platform capabilities**:
   - Call `mcp__keeperhub__list_action_schemas` with `include_full_schemas: true`
   - If MCP is available, use the returned triggers and actions as the definitive list
   - If MCP is unavailable, use the fallback lists in the context section above
   - Note which source was used in the output

2. **Research the target deeply**:
   - If $ARGUMENTS is a contract address (0x...): Use the `analyse-contract` agent
   - If $ARGUMENTS is a protocol name: Use the `analyse-protocols` agent AND `discover-keepers` agent in parallel
   - If $ARGUMENTS is a URL: Fetch and analyze the content, then research the protocols/concepts referenced
   - If $ARGUMENTS is a topic/case study: Use web research to understand the domain
   - Identify the smart contracts, functions, events, operational patterns, and pain points

3. **Find automation gaps** -- the core of this analysis:
   - What operations are currently manual or fragile for this target?
   - What cross-protocol interactions could be automated?
   - What data from one contract could trigger actions on another?
   - What multi-step DeFi strategies could become one-click workflows?
   - What security monitoring doesn't exist but should?
   - What operational intelligence could be derived from on-chain data?
   - What would save the most time, gas, or reduce the most risk?

4. **Design workflows that close those gaps** -- for each:
   - Can this be built TODAY with existing triggers, actions, and nodes?
   - If not, what specific new plugin or trigger is missing?
   - What is the operational value: time saved, risk reduced, gas optimized, reliability improved?
   - Think about: trigger types (existing or new), action sequences, conditional logic, state persistence via Database nodes, notification routing

5. **Structure each workflow suggestion as**:

   ```
   ## Workflow: [Name]

   **The gap**: What manual/fragile/missing automation this addresses
   **The idea**: 1-2 sentence description of the automation
   **Value**: Concrete operational benefit (time saved, risk reduced, gas optimized, etc.)

   **Trigger**: [type] - [description]
   (mark as EXISTING or NEW TRIGGER)

   **Nodes**:
   1. [node type] - [what it does]
   2. [node type] - [what it does]
   ...
   (mark each as EXISTING or NEW PLUGIN with a brief spec for new ones)

   **Flow**: visual representation of the DAG

   **Buildable today?**: Yes / Partially (what's missing) / No (what needs to be built)
   **Value proposition**: Why a team would pay for this
   ```

6. **Propose new plugin concepts** (only for gaps that require them):
   For each new node type or plugin referenced, provide:
   - Plugin name and category
   - What it does (input -> output)
   - Why it needs to be a first-class node (not just a webhook workaround)
   - Which workflows it unlocks

7. **Prioritize by value**:
   - Rank workflows by operational impact (high/medium/low)
   - Separate into: buildable today vs requires new plugins
   - For new plugins, identify the highest-leverage one (unlocks the most valuable workflows)

</process>

<output>
Structure the output as:

1. **Target Analysis** - What we researched, key findings, and identified automation gaps
2. **Capability Source** - Whether MCP or fallback was used for platform capabilities
3. **Workflow Suggestions** (5-10) - Each with the full structure above, prioritized by operational value
4. **Buildable Today** - Which workflows can be assembled immediately with existing capabilities
5. **New Plugin / Node Type Proposals** - Specific new capabilities needed to close remaining gaps, with specs
6. **Priority Ranking** - Workflows ranked by value to web3 protocol dev and ops teams, with buildability status
7. **Competitive Moat** - Why these workflows would be hard to replicate and valuable to the target audience
</output>

<success_criteria>
- Every workflow addresses a specific, real automation gap for the target -- not generic blockchain monitoring
- Workflows are prioritized by operational value: time saved, risk reduced, gas optimized, reliability improved
- Workflows use existing KeeperHub capabilities wherever possible -- prefer buildable-today solutions
- When new plugins are proposed, they are driven by genuine gaps (not novelty for its own sake)
- Every new plugin proposal includes: name, category, input/output spec, and which workflows it enables
- Ideas go beyond "monitor and alert" -- include multi-step DeFi operations, cross-protocol coordination, intelligent automation
- The output reads as a value-first analysis: "here are the biggest automation gaps and how KeeperHub closes them"
- Platform capabilities were sourced from MCP when available, with fallback noted if used
</success_criteria>
