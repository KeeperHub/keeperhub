# Weft × KeeperHub — Agent Onchain Starter Template

**Purpose:** Get a builder from zero to their first KeeperHub-executed onchain transaction in under 15 minutes.  
**Intended home:** PR to [KeeperHub/keeperhub](https://github.com/KeeperHub/keeperhub) under `docs/examples/weft-starter.md` (Agents Onchain hackathon onboarding bounty).

---

## What you get

[Weft](https://github.com/thisyearnofear/weft) is an autonomous milestone verifier: three agent nodes collect deterministic evidence (deployment check, unique callers, GitHub commits), reach offchain consensus, then **execute `submitVerdict()` onchain via KeeperHub**.

This template shows two KeeperHub surfaces:

| Surface | When to use |
|---|---|
| **MCP** (`KEEPERHUB_TRANSPORT=mcp`) | Daemon / agent runtime — simulate → broadcast → poll audit trail |
| **Workflow builder** | Visual ops — import `weft-verdict-workflow.json` for manual or webhook-triggered runs |

---

## Prerequisites

1. [KeeperHub account](https://app.keeperhub.com) with **wallet integration** configured for your target chain
2. Organization API key (`kh_…`) from **Settings → API Keys → Organisation**  
   ⚠️ Webhook keys (`wfb_…`) do **not** work for MCP or direct execution
3. Testnet funds on the org wallet (0G Galileo: chain ID **16602**)

> **Common blocker:** `kh auth status` shows `Organization` empty or execution returns `401 Unauthorized`.  
> Fix: select/create an org in the app UI, connect a wallet integration for your chain, fund it, then mint a **new** org-scoped `kh_` key. Until the org wallet is configured, MCP `tools/call` and `/api/execute/*` reject the key even though `initialize` succeeds.

---

## Path A — MCP (recommended for agents)

### 1. Connect KeeperHub MCP

```bash
claude mcp add --transport http --scope user keeperhub https://app.keeperhub.com/mcp \
  --header "Authorization: Bearer kh_your_key_here"
```

Or in Claude Desktop config:

```json
{
  "mcpServers": {
    "keeperhub": {
      "type": "http",
      "url": "https://app.keeperhub.com/mcp",
      "headers": { "Authorization": "Bearer kh_your_key_here" }
    }
  }
}
```

### 2. Preflight with simulation (safe first write)

Ask your agent (or call the tool directly):

```json
{
  "name": "execute_contract_call",
  "arguments": {
    "contract_address": "0x9f66158c560ce5c8b40820fdcd2874ff8d852192",
    "network": "16602",
    "function_name": "submitVerdict(bytes32,bool,bytes32)",
    "function_args": "[\"0x516975afcb46acf3ea2265789ea0a64516db9f1d8e6cfb65737fc9cfafb1c16f\", \"true\", \"0x0000000000000000000000000000000000000000000000000000000000000000\"]",
    "simulate": true
  }
}
```

Continue only when `success: true` and `wouldRevert: false`.

### 3. Broadcast with idempotency

Repeat the same arguments, **omit** `simulate`, add `idempotency_key`:

```json
{
  "name": "execute_contract_call",
  "arguments": {
    "contract_address": "0x9f66158c560ce5c8b40820fdcd2874ff8d852192",
    "network": "16602",
    "function_name": "submitVerdict(bytes32,bool,bytes32)",
    "function_args": "[\"0x516975af…\", \"true\", \"0x0000…\"]",
    "idempotency_key": "weft-verdict-<milestone-hash>-<verifier>-1"
  }
}
```

Save the returned `executionId`.

### 4. Poll until settled

```json
{
  "name": "get_direct_execution_status",
  "arguments": { "execution_id": "<executionId>" }
}
```

Poll with backoff until `status` is `completed` or `failed`. Link the `transactionHash` / `transactionLink` in your hackathon submission.

### 5. Run Weft daemon with MCP transport

```bash
export KEEPERHUB_API_KEY=kh_...
export KEEPERHUB_TRANSPORT=mcp
export ETH_RPC_URL=https://evmrpc-testnet.0g.ai
export WEFT_CONTRACT_ADDRESS=0x9f66158c560ce5c8b40820fdcd2874ff8d852192
export CHAIN_ID=16602
export PRIVATE_KEY=0x...   # verifier key (fallback if KeeperHub unavailable)

python3 agent/scripts/weft_daemon.py --once
```

The daemon writes `keeperhub_audit.json` into the attestation directory with `transport: "mcp"` and the MCP endpoint for provenance.

---

## Path B — Workflow builder

1. Open KeeperHub → **Workflows** → **Create**
2. Import or recreate nodes from [`weft-verdict-workflow.json`](./weft-verdict-workflow.json):
   - **Manual trigger** with pin data: `milestoneHash`, `verified`, `evidenceRoot`
   - **web3/write-contract** → `submitVerdict(bytes32,bool,bytes32)` on network `16602`
   - Optional **release(bytes32)** step after quorum finalizes
3. **Validate** → **Execute** → copy execution ID and tx hash from run logs

Or create via MCP:

```
ai_generate_workflow: "On 0G testnet chain 16602, call WeftMilestone submitVerdict then release"
validate_workflow → create_workflow → execute_workflow
```

---

## Where we got stuck (and fixes we'd PR upstream)

| Pain point | Workaround today | Proposed KeeperHub fix |
|---|---|---|
| `kh_` vs `wfb_` key confusion | Docs callout above | First-run MCP error with link to Organisation keys tab |
| REST vs MCP parameter names | Weft maps `functionSignature` → MCP `function_name` | Align REST + MCP field names in `tools_documentation` |
| Status enum drift (`confirmed` vs `completed`) | Client normalizes both | Document canonical status values for direct execution |
| 0G chain ID not in default list | Pass `"16602"` explicitly | Add 0G Galileo to chain picker + examples |

These rows are the hackathon **Best Onboarding UX Improvement** bounty — a merged doc PR or starter template counts.

---

## Verify it worked

```bash
# Smoke test MCP session + simulate (no broadcast)
KEEPERHUB_API_KEY=kh_... python3 agent/scripts/weft_keeperhub_mcp_smoke.py

# Check audit artifact after a real verdict
cat agent/.attestations/<milestone>/keeperhub_audit.json
```

Expected audit fields:

```json
{
  "execution_id": "direct_…",
  "status": "confirmed",
  "tx_hash": "0x…",
  "transport": "mcp",
  "mcp_endpoint": "https://app.keeperhub.com/mcp",
  "logs": [ … ]
}
```

---

## Links

- **Weft repo:** https://github.com/thisyearnofear/weft  
- **Live demo:** https://weft.thisyearnofear.com/recovery (chaos → KeeperHub retry)  
- **KeeperHub MCP docs:** https://docs.keeperhub.com/ai-tools/mcp-server  
- **Hackathon:** https://dorahacks.io/hackathon/agents-onchain  

---

*Submitted for the KeeperHub Agents Onchain hackathon (Jul–Aug 2026). PR this file to `KeeperHub/keeperhub/docs/examples/weft-starter.md`.*
