---
title: "Agentic Wallets"
description: "Install an x402/MPP wallet in your AI agent to pay for KeeperHub workflows or any x402/MPP service. Covers the first-party KeeperHub agentic wallet plus the main third-party options."
---

# Agentic Wallets

KeeperHub paid workflows settle via [x402](https://docs.cdp.coinbase.com/x402) on Base USDC or MPP on Tempo USDC.e: each call carries a USDC payment, and the server returns a result only after the payment is verified. To call a paid workflow, your agent needs an x402/MPP wallet.

This page covers the first-party **KeeperHub agentic wallet** (skill + npm package, server-side Turnkey custody) and the main third-party alternatives. Every wallet listed works with KeeperHub and with any other x402/MPP-compliant service.

## KeeperHub agentic wallet

A skill + npm package from KeeperHub. Custody is server-side in a per-wallet [Turnkey sub-organisation](https://docs.turnkey.com/concepts/sub-organizations), so no private key lands on disk. A `PreToolUse` hook gates every signing call against a three-tier (auto / ask / block) policy sourced from `~/.keeperhub/safety.json`.

### Install

Two steps: register the skill + safety hook, then provision a wallet. Run the commands yourself, or have your agent do it for you.

**Manual:**

```bash
npx -p @keeperhub/wallet keeperhub-wallet skill install
npx -p @keeperhub/wallet keeperhub-wallet add
```

**Have your agent do it:** paste this prompt:

> Install the KeeperHub agentic wallet: run `npx -p @keeperhub/wallet keeperhub-wallet skill install` to register the skill and safety hook, then `npx -p @keeperhub/wallet keeperhub-wallet add` to provision a new wallet. Report the subOrgId and wallet address when done.

The install step writes the skill file into every detected agent skill directory (Claude Code, Cursor, Cline, Windsurf, OpenCode) and registers the `keeperhub-wallet-hook` `PreToolUse` safety hook in `~/.claude/settings.json`. The `add` step provisions a fresh Turnkey sub-organisation and writes `~/.keeperhub/wallet.json` (mode `0600`). The file contains only your sub-org identifier, your EVM wallet address, and an HMAC shared secret used to authenticate signing requests against KeeperHub — **no private key**. The signing key material is generated inside [Turnkey's secure enclave](https://docs.turnkey.com/concepts/overview#the-system-level-threat-model-we-solve) and never leaves it; nothing in `wallet.json` alone is enough to sign a transaction.

Restart your agent session once after this so it picks up the newly installed skill.

### First payment

The wallet handles payment; the agent still needs a way to discover and call KeeperHub workflows. That comes from the [KeeperHub MCP server](/agent/mcp-server), which exposes the `search_workflows` and `call_workflow` meta-tools to your agent. You can install the MCP server on its own (see the [MCP server](/agent/mcp-server) page) or bundled with the [KeeperHub Claude Code plugin](/agent/claude-code-plugin), which wires both the MCP server and (soon) the wallet skill in one step.

With MCP + wallet both installed, ask your agent in plain language:

> Use KeeperHub to check the ETH balance of `0xAA70fAa583c0889164cFD9b45Aa075F6c4388Fee`.

> Run the KeeperHub `mcp-test` workflow for `0xAA70...`.

The agent discovers available workflows at runtime through the KeeperHub meta-tools (`search_workflows` + `call_workflow`) and picks the best match. When a paid workflow returns a `402`, the wallet intercepts the challenge, signs through the server-side proxy (x402 on Base USDC or MPP on Tempo USDC.e), and the call retries transparently. Most KeeperHub paid workflows accept both protocols; today the wallet pays via x402 by default and uses MPP when the workflow is MPP-only. If the amount exceeds your `auto_approve_max_usd` the safety hook surfaces an inline permission prompt before any payment is authorised.

### Safety hooks

Every wallet signing call is gated by a `PreToolUse` hook that reads thresholds from `~/.keeperhub/safety.json` (never from the transaction payload):

| Tier  | Behaviour                                                                 |
|-------|---------------------------------------------------------------------------|
| auto  | Amount at or below `auto_approve_max_usd` signs without prompting.        |
| ask   | Amount above `auto_approve_max_usd` and at or below `block_threshold_usd` returns `{decision: "ask"}` so Claude Code surfaces an inline prompt in the agent chat. |
| block | Amount above `block_threshold_usd`, or a contract not in `allowlisted_contracts`, is denied without calling `/sign`. |

The hook reads only the payment-challenge fields `amount`, `unit`, and the asset contract address from the tool payload. Forged fields like `trust-level hint` or `admin-override` are ignored by design.

> **The allowlists cover which token is spent. The recipient is pinned somewhere else.**
>
> `allowlisted_contracts` and the [server-side contract allowlist](#server-side-hard-limits) both constrain the ERC-20 being transferred. Neither reads the challenge's `payTo` — so no *allowlist*, local or Turnkey, restricts who is paid. That is deliberate: `payTo` is the facilitator or service operator, not the contract being invoked, so it is not what a contract allowlist should match on.
>
> **The recipient is constrained by `/sign`'s workflow binding instead.** A signing request must carry a `workflowSlug`; the route derives the expected recipient from that workflow's organisation wallet and rejects a mismatch with `403 PAYTO_MISMATCH`. So an arbitrary destination is refused — by the workflow binding, not by an allowlist and not by a Turnkey policy.
>
> Two consequences worth knowing. The client-side tiers approve without ever considering the recipient, so a local `allowlisted_contracts` entry gives no assurance about *where* funds go. And the hook is stateless — it sees one payment at a time, so repeated payments each under `auto_approve_max_usd` all pass. The bound on that is server-side: the [daily spend cap](#server-side-hard-limits), plus a server-side `ask` at 50 USDC and `block` above 100 USDC that apply on every signing request independently of `safety.json`.
>
> If your agent should only pay a specific subset of workflows, or should hold to a budget you set, enforce that in your own `PreToolUse` hook or in a wrapper around `paymentSigner`. The tiers above will not do it for you.

### Server-side hard limits

Beyond the client-side hook, a set of Turnkey-enforced policies apply to every wallet and cannot be bypassed by editing `safety.json` or changing the agent's hook. They are created per sub-organisation at provision time and enforced by Turnkey itself on every signing activity:

- **Contract allowlist.** Signing is denied on any call whose target contract is not Base USDC (`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`) or Tempo USDC.e (`0x20c000000000000000000000b9537d11c60e8b50`). On the EIP-712 (x402) signing path the same restriction is applied against the typed-data domain's verifying contract.
- **Per-transfer cap.** `transfer()` or `transferFrom()` of more than 100 USDC is denied. The same 100 USDC ceiling applies to EIP-3009 `TransferWithAuthorization` typed-data signing.
- **Approval cap.** `approve()` above 100 USDC is denied. Anything over the same 100 USDC per-transfer ceiling is rejected.
- **Chain allowlist.** EIP-712 signing is denied for any `domain.chainId` outside Base (8453), Tempo mainnet (4217), and Tempo testnet (42431).
- **Daily spend cap.** Aggregate signed payments per wallet are bounded at **200 USDC per UTC day** by default. Requests that would exceed the cap return `429 DAILY_CAP_EXCEEDED` with a `Retry-After` header counting down to the next UTC midnight. The cap protects against a compromised HMAC secret being used to drain the wallet faster than an operator can notice and rotate. If a legitimate workflow needs a higher cap, contact KeeperHub support.

These are defence-in-depth: even if an attacker bypassed the client-side hook entirely, Turnkey rejects the signature. They are also **not user-configurable today**. If you have a legitimate need to sign transfers above 100 USDC or to interact with contracts outside the USDC allowlist, contact KeeperHub support — a sub-organisation with a different policy set is possible but requires an operator action. Self-serve higher-cap configuration is on the roadmap.

### Default safety config

When `~/.keeperhub/safety.json` is absent the hook applies these defaults:

```json
{
  "auto_approve_max_usd": 5,
  "ask_threshold_usd": 50,
  "block_threshold_usd": 100,
  "allowlisted_contracts": [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0x20c000000000000000000000b9537d11c60e8b50"
  ]
}
```

> **`ask_threshold_usd` is inert, but it is not inconsequential.**
>
> It is part of `DEFAULT_SAFETY_CONFIG` and is still parsed and range-checked — it must be `>= auto_approve_max_usd`, and `block_threshold_usd` must be `>= ask_threshold_usd` — but the hook does not consult it when deciding. The ask tier is bounded by `auto_approve_max_usd` and `block_threshold_usd` alone, as the table above describes. The field is retained for backward compatibility with existing configs.
>
> **Any edit that raises `auto_approve_max_usd` above 50, or lowers `block_threshold_usd` below 50, must write `ask_threshold_usd` too.** Both directions throw, and the default of 50 sits between them. A partial config is merged over the defaults, so writing only:
>
> ```json
> { "auto_approve_max_usd": 1, "block_threshold_usd": 20 }
> ```
>
> leaves `ask_threshold_usd` at its default of 50, which trips `block_threshold_usd must be >= ask_threshold_usd`. The mirror case is just as easy to hit: `{ "auto_approve_max_usd": 60 }` leaves `ask_threshold_usd` at 50 and trips `ask_threshold_usd must be >= auto_approve_max_usd`.
>
> Either error is thrown while the hook is being constructed, before any input is read, so the hook process exits non-zero — **and because `skill install` registers it with `matcher: "*"`, the failure blocks the whole session rather than just wallet calls.** (A hand-registered hook with a narrower matcher fails only for the tools it matches.) The only explanation is a single line on stderr.
>
> Write all three together, or keep `auto_approve_max_usd` ≤ 50 ≤ `block_threshold_usd`.

The two allowlisted addresses are the only tokens the client-side hook will authorise out of the box:

- `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` — **Base USDC**. Canonical Circle USDC contract on Base mainnet (chain id 8453). Used by x402 challenges from KeeperHub and any other x402-compliant service.
- `0x20c000000000000000000000b9537d11c60e8b50` — **Tempo USDC.e**. USDC bridge token on Tempo mainnet (chain id 4217). Used by MPP challenges from KeeperHub paid workflows that settle on Tempo.

`allowlisted_contracts` in `safety.json` is a client-side first-pass filter — the hook rejects signing calls whose target contract is not in this list. You can **narrow** it further (for example, remove Tempo USDC.e if your agent only pays on Base). You cannot **widen** it: adding a third contract here has no effect because the [server-side hard limits](#server-side-hard-limits) still restrict every signature to Base USDC + Tempo USDC.e. For access to other contracts, contact KeeperHub support so a sub-organisation with a different server-side allowlist can be provisioned.

## Alternatives

### agentcash

`agentcash` is a CLI + skill bundle from [agentcash.dev](https://agentcash.dev). It maintains a local USDC wallet and signs x402 payments on the agent's behalf.

```bash
npx agentcash add https://app.keeperhub.com
```

This walks KeeperHub's `/openapi.json`, generates a `keeperhub` skill file, and symlinks it into every detected agent skill directory. After install, agents can call `search_workflows` and `call_workflow` as first-class tools; payment is routed through the agentcash wallet automatically.

Supported agents (17 at time of writing): Claude Code, Cursor, Cline, Windsurf, Continue, Roo Code, Kilo Code, Goose, Trae, Junie, Crush, Kiro CLI, Qwen Code, OpenHands, Gemini CLI, Codex, GitHub Copilot.

> **Testing only. Do not custody real funds.**
> agentcash stores the wallet key as an **unencrypted plaintext file** at `~/.agentcash/wallet.json`. There is no passphrase, no keychain integration, and no seed-phrase backup: if the file is deleted, lost, or read by any process running as your user, the funds are gone or stolen. This is appropriate for development and automation experiments with small balances (a few dollars of USDC for test calls); it is not a production wallet.
>
> KeeperHub does not operate agentcash and is not responsible for funds stored in an agentcash wallet. Use it at your own risk and do not top it up beyond what you are willing to lose.

### Coinbase agentic wallet skills

Coinbase publishes a bundle of 9 general-purpose x402 skills that work with any x402-compliant service, KeeperHub included:

```bash
npx skills add coinbase/agentic-wallet-skills
```

This installs skills including `authenticate-wallet`, `fund`, `pay-for-service`, `search-for-service`, `send-usdc`, `trade`, `query-onchain-data`, and `x402`. The wallet is managed through Coinbase Developer Platform; payment flows route through the CDP infrastructure.

Full documentation and security risk ratings: https://skills.sh/coinbase/agentic-wallet-skills

## Comparison

| Feature                 | KeeperHub Agentic Wallet                               | agentcash                                           | Coinbase agentic-wallet-skills                                     |
|-------------------------|--------------------------------------------------------|-----------------------------------------------------|--------------------------------------------------------------------|
| Key custody             | Server-side Turnkey enclave; agent holds HMAC secret   | Plaintext JSON on disk (`~/.agentcash/wallet.json`) | Coinbase Developer Platform (CDP) managed or self-custody variants |
| Private key on disk     | Never                                                  | Yes (unencrypted)                                   | Depends on variant                                                 |
| Payment protocols       | x402 (Base USDC) + MPP (Tempo USDC.e)                  | x402                                                | x402 (Coinbase ecosystem)                                          |
| PreToolUse safety hook  | Three-tier auto/ask/block built-in                     | Not bundled                                         | Not bundled                                                        |
| Onboarding              | Zero-registration, under 60 seconds                    | Zero-registration                                   | Requires CDP account for the managed variant                       |
| Install                 | `npx -p @keeperhub/wallet keeperhub-wallet skill install`                  | `npx agentcash add https://app.keeperhub.com`       | `npx skills add coinbase/agentic-wallet-skills`                    |

## Choosing a wallet

All three wallets call any x402-compliant service, KeeperHub included. The choice comes down to custody and ecosystem fit rather than anything KeeperHub-specific.

The KeeperHub agentic wallet is a managed service: KeeperHub runs the Turnkey sub-organisation and proxies signing. You trust KeeperHub to honour the [server-side hard limits](#server-side-hard-limits) and the `PreToolUse` hook decision. In return you get no-plaintext-key storage, a three-tier safety hook out of the box, and zero-registration onboarding.

agentcash is fully self-custodial, with plaintext key material at rest. It fits development and automation experiments with small balances; it is not a production wallet for funds you care about.

Coinbase agentic wallet skills assume the CDP ecosystem for the managed variant. A good fit if you already run on CDP; otherwise it introduces Coinbase platform lock-in.

Nothing stops you installing multiple wallets side by side; they do not conflict.

## What KeeperHub exposes to the agent

Whichever wallet you install, the agent calls KeeperHub through two meta-tools (described in its OpenAPI at `/openapi.json`):

- `search_workflows` — find workflows by category, tag, or free text. Returns slug, description, inputSchema, and price for each match.
- `call_workflow` — execute a listed workflow by slug. For read workflows the call executes and returns the result; for write workflows it returns unsigned calldata `{to, data, value}` for the caller to submit.

The meta-tool pattern keeps the agent's tool list small regardless of how many workflows are listed: the agent discovers available workflows at runtime instead of registering one tool per workflow.

## Paying for calls

Paid workflows settle in USDC on Base (via x402) or USDC.e on Tempo (via MPP). Most workflows cost under `$0.05` per call. See [Marketplace](/workflows/marketplace) for the creator-side view of the same settlement.

## Known limitations

- Signing is supported on Base (8453), Tempo mainnet (4217), and Tempo testnet (42431) today. Solana, Arbitrum, Optimism and other chains are not yet supported.
- Ask-tier approvals are surfaced inline via the agent's permission prompt. A browser-based review flow for larger amounts is on the roadmap.
- Workflow discovery via the skill is scoped to KeeperHub's registry. The wallet auto-pays any x402 or MPP 402 challenge you direct it at, but discovering third-party x402 services from the agent is on the roadmap.

## FAQ

### Who controls my wallet?

KeeperHub does, today. Each wallet is a [Turnkey sub-organisation](https://docs.turnkey.com/concepts/sub-organizations) where KeeperHub holds the only root user — a server-side API key inside a Turnkey enclave. Your agent does not hold a private key. When your agent needs to pay, it sends a signed request to KeeperHub, KeeperHub checks it against the safety policy engine, and Turnkey produces the signature.

This is a custodial model. You are trusting KeeperHub to honour the policy limits on every signing call. In exchange you get zero-registration onboarding, no private keys on disk, and no seed phrase to back up.

### What stops KeeperHub signing whatever it wants?

A set of Turnkey policies, applied per sub-organisation at provision time and enforced by Turnkey itself (not by application code). Full list above under [Server-side hard limits](#server-side-hard-limits). Briefly: signing only against the Base USDC / Tempo USDC.e contracts, no `approve()` above 100 USDC, no `transfer()` or `transferFrom()` above 100 USDC, and EIP-712 signing restricted to allowlisted chain ids and verifying contracts.

If KeeperHub's operator key is compromised, the attacker is still bound by these policies. They cannot approve an arbitrary contract to spend your balance, and they cannot sign against a contract outside [the allowlisted set](#server-side-hard-limits) — Base USDC, Tempo USDC.e, and the ERC-8004 `ReputationRegistry`. The registry is bound to Ethereum mainnet and restricted to `giveFeedback()`, so it moves no funds, but it is a third allowlisted destination and not a USDC contract.

**The recipient constraint is weaker than the ones above, and the difference matters here.** An attacker also cannot drain funds to an arbitrary address — but that comes from `/sign`'s workflow binding, not from the Turnkey policy set. The policy conditions cover `eth.tx.to` and `eth.eip_712.domain.verifying_contract`; neither is the transfer recipient. `verifyWorkflowBinding` is application code that reads the `workflows` and `organizationWallets` tables and rejects a mismatch with `403 PAYTO_MISMATCH`.

So the Turnkey policies survive a compromise of the application because Turnkey enforces them. The recipient pin holds only while the application and those records are intact — it is the compromised application checking itself. See [the note under Safety hooks](#safety-hooks).

### What happens if I lose `wallet.json`?

Today, the wallet is not recoverable. `wallet.json` holds the HMAC secret that authenticates your agent against KeeperHub; without it there is no way to re-authenticate to the same sub-org. Running `npx -p @keeperhub/wallet keeperhub-wallet add` again creates a brand new sub-org with a brand new address. Any funds in the old wallet stay there but are unreachable.

Back up `wallet.json` the same way you would back up an SSH key. A passkey-backed recovery path is on the roadmap.

### Can I move the wallet to another machine?

Yes. `wallet.json` is the wallet from your agent's perspective. Copy it to another machine (under `~/.keeperhub/wallet.json`, mode `0600`) and that machine speaks for the same wallet. Treat it like any other long-lived credential.

### Does KeeperHub have access to my funds?

KeeperHub can produce signatures for your wallet, but only within the limits of the [server-side hard limits](#server-side-hard-limits). KeeperHub never sees a private key — the key material lives inside Turnkey's secure enclave, and Turnkey is the one that produces signatures after KeeperHub's API key passes the policy engine.

### Why don't I have a passkey or 2FA option?

Passkey-backed sub-orgs are a more secure option Turnkey supports natively, and it's on the roadmap as an opt-in enrolment. The default today is convenience-first — onboard in under a minute, no ceremony — because that's what unblocks trying an agent-paid workflow. Users who want a break-glass signing authority and a recovery path will get a `--with-passkey` provisioning mode in a future release.

### Can I change the safety thresholds or the allowed contracts?

You can edit `~/.keeperhub/safety.json` (mode `0644`) to raise or lower `auto_approve_max_usd` and `block_threshold_usd`, or to narrow `allowlisted_contracts` (for example, drop Tempo USDC.e if your agent only pays on Base). The hook picks up changes on its next invocation.

The file also carries `ask_threshold_usd`, which the hook does not consult but does validate. If you are raising `auto_approve_max_usd` above 50 **or** lowering `block_threshold_usd` below 50, read [the note under Default safety config](#default-safety-config) first — either edit fails validation in a way that blocks every tool call, not only wallet ones.

Raising thresholds raises your exposure. Widening the contract allowlist past the server-side default (Base USDC + Tempo USDC.e) has no effect on its own — the [server-side hard limits](#server-side-hard-limits) still block signatures against any other contract. If you need access to a different contract, contact KeeperHub support.

### How are signing decisions actually enforced?

Two layers, and they're independent:

1. **Client-side hook**, running inside your agent (Claude Code, etc.). Reads `~/.keeperhub/safety.json`, classifies the amount, and either allows, asks you inline, or denies the call before it ever hits the network. This is what keeps your agent from being manipulated into calling `/sign` for amounts you didn't authorise.
2. **Server-side Turnkey policies**, enforced inside Turnkey for every signing activity. See [Server-side hard limits](#server-side-hard-limits) for the full list. They are the hard floor — a misconfigured hook or a compromised agent still cannot sign outside them.

Either layer alone isn't enough. The hook stops an agent from asking for a bad signature; the policies stop any signature from being produced outside the rules.

### What's the difference between my wallet and my KeeperHub creator wallet?

Two different things:

- The **agentic wallet** is what your agent uses to pay for workflows. It's provisioned per agent install, custodial via Turnkey, not tied to a KeeperHub account.
- A **creator wallet** is what a workflow author sets up to receive payouts. It lives on your KeeperHub account, is managed through the dashboard, and is a separate Turnkey sub-org with a different setup.

Installing an agentic wallet does not touch or affect your creator wallet, and vice versa.

### Can I delete my wallet?

Not through the CLI today. If you've stopped using a wallet and want the sub-org cleaned up, get in touch via the KeeperHub support channel with your `subOrgId` (from `npx -p @keeperhub/wallet keeperhub-wallet info`) and the operator team can remove it.

### What do I actually pay? Do I need ETH for gas?

No ETH, no gas out of your wallet for normal agentic wallet use.

- **x402 on Base.** You sign an EIP-3009 `TransferWithAuthorization` — a pre-signed authorisation that lets the x402 facilitator move USDC on your behalf. The facilitator submits the on-chain transaction and pays the gas. Your wallet only debits the USDC amount.
- **MPP on Tempo.** You sign an authorisation for the MPP facilitator to settle the USDC.e transfer for you. The facilitator pays the Tempo network fees. Your wallet only debits the USDC.e amount.

So for a `$0.05` paid workflow, `$0.05` of USDC (or USDC.e) leaves your wallet — nothing else.

If in future you use the wallet to sign a direct on-chain transaction outside the agentic workflow pattern (e.g. a manual ERC-20 transfer), you'd need native gas for that chain the same way any wallet would.

## Links

- npm: [`@keeperhub/wallet`](https://www.npmjs.com/package/@keeperhub/wallet)
- Skills registry: [`keeperhub/agentic-wallet-skills`](https://skills.sh/keeperhub/agentic-wallet-skills)
- Source: [`KeeperHub/agentic-wallet`](https://github.com/KeeperHub/agentic-wallet).
