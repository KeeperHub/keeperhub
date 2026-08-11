# KeeperHub

## What This Is

A Web3 workflow automation platform (forked from vercel-labs/workflow-builder-template) that enables users to create, manage, and execute blockchain automation workflows. Includes a 5-agent Claude Code development team for automating plugin, protocol, and feature development through a deterministic Blueprint pipeline.

## Core Value

Users can build and deploy Web3 automation workflows through a visual builder without writing code.

## Requirements

### Validated

- ✓ sc-event-tracker monitors blockchain events and triggers workflows -- v1.0
- ✓ sc-event-worker provides HTTP interface for event tracker and forwards executions -- v1.0
- ✓ Scheduler dispatcher queries schedules and dispatches to SQS -- v1.0
- ✓ Scheduler executor polls SQS and triggers workflow executions -- v1.0
- ✓ Main app API endpoints for workflow execution -- v1.0
- ✓ Events services deployed independently from keeperhub-events repo -- v1.0
- ✓ Scheduler services deployed independently from keeperhub-scheduler repo -- v1.0
- ✓ Internal HTTP APIs for scheduler operations (6 endpoints) -- v1.0
- ✓ X-Service-Key authentication for internal APIs -- v1.0
- ✓ OG image routes resolve all dependencies in production K8s build -- v1.1
- ✓ Default, hub, and workflow OG images render valid PNGs in production -- v1.1
- ✓ Font files accessible at runtime in production -- v1.1

### Validated (v1.3)

- ✓ Direct execution REST API endpoints for AI agents (transfer, contract-call, swap, check-and-execute) -- v1.3
- ✓ Execution status polling endpoint -- v1.3
- ✓ API key authentication for execution endpoints -- v1.3
- ✓ Rate limiting per API key -- v1.3
- ✓ Spending cap enforcement per organization -- v1.3
- ✓ Audit logging to direct_executions table -- v1.3

### Validated (v1.2)

- ✓ defineProtocol() system for declarative protocol definitions -- v1.2
- ✓ Protocol definitions auto-generate workflow nodes via existing plugin system -- v1.2
- ✓ ABI auto-resolution from block explorers with caching -- v1.2
- ✓ Multi-chain contract address management per protocol -- v1.2 (WETH: 4 chains)
- ✓ Protocol actions appear in workflow builder and MCP schemas -- v1.2
- ✓ Core logic extraction (read-contract-core, write-contract-core) -- v1.2

### Validated (v1.4)

- ✓ Vitest unit test writing skill for KeeperHub plugin step files -- v1.4 (FOUND-01)
- ✓ Scoped CLAUDE.md in keeperhub/plugins/ for plugin-specific standards -- v1.4 (FOUND-02)
- ✓ Scoped CLAUDE.md in tests/e2e/playwright/ for E2E patterns -- v1.4 (FOUND-03)
- ✓ pnpm build runs as CI check on PRs targeting staging -- v1.4 (FOUND-04)
- ✓ Orchestrator agent (Opus) coordinates other agents via Blueprint pipeline -- v1.4 (AGENT-01)
- ✓ Builder agent (Sonnet) implements code passing lint, type-check, build -- v1.4 (AGENT-02)
- ✓ Verifier agent (Sonnet) performs read-only quality review and gates PR creation -- v1.4 (AGENT-03)
- ✓ Researcher agent (Sonnet) explores codebase and gathers implementation context -- v1.4 (AGENT-04)
- ✓ Debugger agent (Sonnet) investigates failures using scientific method -- v1.4 (AGENT-05)
- ✓ Blueprint pipeline: DECOMPOSE -> RESEARCH -> IMPLEMENT -> VERIFY -> PR -- v1.4 (PIPE-01)
- ✓ /add-protocol uses agent pipeline for protocol definitions -- v1.4 (PIPE-02)
- ✓ /add-plugin uses agent pipeline for plugin creation -- v1.4 (PIPE-03)
- ✓ /add-feature uses agent pipeline for general feature development -- v1.4 (PIPE-04)
- ✓ Human review gate blocks PR for high-risk changes -- v1.4 (SAFE-01)
- ✓ 2-round iteration limit escalates to human -- v1.4 (SAFE-02)
- ✓ Build verification (pnpm build) before PR creation -- v1.4 (SAFE-03)
- ✓ Verifier agent approval required before PR creation -- v1.4 (SAFE-04)

### Validated (v1.7)

- ✓ `inputSchema`, `outputMapping`, `isListed`, `listedSlug`, `priceUsdcPerCall`, `workflowType`, `category`, `chain` columns on `workflows` -- v1.7
- ✓ Listing API + UI: GET/POST `/api/mcp/workflows`, List overlay, per-workflow slug uniqueness -- v1.7
- ✓ MCP meta-tools `search_workflows` + `call_workflow` (not one-tool-per-workflow) -- v1.7
- ✓ Instruction-only mode for write workflows (returns unsigned calldata `{to, data, value}`) -- v1.7
- ✓ Public workflow catalog at `/openapi.json` + `/api/mcp/workflows` -- v1.7
- ✓ ERC-8004 registration: single KeeperHub identity NFT, `keeperhub.eth` ENS, HTTPS-hosted registration file -- v1.7
- ✓ x402 payment gate: Base USDC settlement via CDP facilitator -- v1.7
- ✓ MPP payment gate: Tempo USDC.e settlement via mppx (dual-protocol 402 challenge) -- v1.7
- ✓ `workflow_payments` table with idempotent recording (paymentHash SHA-256) -- v1.7
- ✓ Creator wallet resolution (organization_wallets) + per-workflow pricing UI -- v1.7
- ✓ Earnings dashboard with per-chain (Base/Tempo) breakdown + docs tooltip -- v1.7
- ✓ Discovery scanner compatibility: agentcash, x402scan, mppscan via canonical `PAYMENT-REQUIRED` header + `extensions.bazaar.schema` -- v1.7
- ✓ CDP Bazaar (agentic.market) discoverability: `extensions.bazaar.discoverable:true`, category/tags, public resource URL -- v1.7
- ✓ Public docs: `docs/workflows/paid-workflows`, `docs/ai-tools/agent-wallets` -- v1.7
- ✓ Tempo chain ID standardized on 4217 (legacy 42420 purged with CI guard) -- v1.7

### Validated (v1.5)

- ✓ Go module as standalone repo with Cobra command tree -- Phase 19
- ✓ IOStreams abstraction for testable I/O -- Phase 19
- ✓ Factory DI struct wiring config, auth, HTTP, and I/O -- Phase 19
- ✓ XDG-based config and multi-host hosts.yml -- Phase 19
- ✓ Version injection via ldflags + go:embed fallback -- Phase 19, Phase 24
- ✓ Retryable HTTP client with version header middleware -- Phase 19
- ✓ All noun commands with shorthand aliases (14 aliases) -- Phase 19
- ✓ All verb subcommands with skeleton RunE handlers -- Phase 19
- ✓ CGO_ENABLED=0 cross-compilation (darwin/linux/windows x amd64/arm64) -- Phase 19
- ✓ CI pipeline (golangci-lint + go test) -- Phase 19
- ✓ GoReleaser config for release automation -- Phase 19
- ✓ Device code auth flow with keychain token storage -- Phase 20
- ✓ Output system (--json, --jq, table, Printer) with exit code contract -- Phase 20
- ✓ Workflow CRUD, run monitoring, direct execute commands -- Phase 21
- ✓ Project, tag, org, action, protocol, wallet, template, billing, doctor commands -- Phase 22
- ✓ MCP server mode (`kh serve --mcp`) with dynamic tool registration -- Phase 23
- ✓ Generated docs, help topics, README -- Phase 23
- ✓ --host flag resolution, HTTP status fixes, --limit client-side -- Phase 24.1
- ✓ gh-style output: tab-delimited pipes, relative timestamps, colored status, --web -- Phase 24.1
- ✓ Homebrew tap, GoReleaser releases, kh update, shell completions -- Phase 24

### Validated (v1.8)

- ✓ Isolated agentic-wallet Turnkey module (`lib/turnkey/agentic-wallet.ts`) with apex `keeperhub.com` RPID -- Phase 32
- ✓ `agentic_wallets` + `wallet_approval_requests` tables + Drizzle migration applied -- Phase 32
- ✓ Zero-auth `POST /api/agentic-wallet/provision` returns `{subOrgId, walletAddress, hmacSecret}` + $0.50 credit in ≤10s -- Phase 33
- ✓ HMAC-authenticated `POST /api/agentic-wallet/sign` with EIP-3009 (x402) + MPP credential signing; Turnkey policies enforced at provision -- Phase 33
- ✓ Approval-request CRUD + risk classifier for ask-tier human-in-the-loop flow -- Phase 33
- ✓ `POST /api/agentic-wallet/link` associates anon `subOrgId` with KeeperHub user (dual-proof HMAC+session) -- Phase 33
- ✓ `@keeperhub/wallet` npm package scaffold with HMAC client mirroring server byte-for-byte, KeeperHubClient envelope, storage at `~/.keeperhub/wallet.json` (0600) -- Phase 34
- ✓ `paymentSigner.pay(response)` with MPP-preferred dual-challenge x402+MPP orchestration -- Phase 34
- ✓ `checkBalance()` unified Base USDC + Tempo USDC.e + off-chain credit via `GET /api/agentic-wallet/credit` -- Phase 34
- ✓ `fund()` prints Coinbase Onramp URL + Tempo address, pure CLI, ASCII-only -- Phase 34
- ✓ PreToolUse hook with three-tier auto/ask/block decisions from `~/.keeperhub/safety.json` only, forged-flag defense -- Phase 34
- ✓ Zero-install-scripts supply-chain hardening + CI gate with `pnpm audit --prod --audit-level high` -- Phases 34+35
- ✓ Skill file `keeperhub-wallet.skill.md` + cross-agent discovery (Claude Code, Cursor, Cline, Windsurf, OpenCode) -- Phase 35
- ✓ Idempotent `npx @keeperhub/wallet skill install` + settings.json patcher that preserves unrelated keys -- Phase 35
- ✓ OIDC trusted publishing via `.github/workflows/publish-wallet.yml` (no NPM_TOKEN) + skills repo sync workflow -- Phase 35
- ✓ `kh wallet add/info/fund/link` Cobra wrappers shelling to `npx @keeperhub/wallet` -- Phase 35
- ✓ Public docs `docs/ai-tools/agentic-wallet.md` with honest competitive positioning vs agentcash + Coinbase -- Phase 36
- ✓ `docs/ai-tools/agent-wallets.md` updated to list KeeperHub first-class + 8-line npm README -- Phase 36

### Validated (v1.9)

- ✓ Separate sandbox Pod in `keeperhub` namespace with dedicated ServiceAccount (no IRSA, `automountServiceAccountToken: false` at SA + Pod level) -- Phases 37, 38, 39
- ✓ `node:vm` + `child_process` runner reused verbatim from PR #953 (commit `a93ce4b9`) with main-app imports stripped -- Phase 37
- ✓ `lib/sandbox-client.ts` main-app HTTP client with keep-alive `http.Agent` and byte-identical `\x01RESULT\x02` sentinel wire format -- Phase 37
- ✓ `SANDBOX_BACKEND=local|remote` selector in `plugins/code/steps/run-code.ts` (default `local` for dev, `remote` in staging/prod Helm values) -- Phase 37
- ✓ 5-test escape-matrix suite (`tests/e2e/sandbox-escape/escape-matrix.spec.ts`) covering process.env, /proc/self/environ, /proc/1/environ, SA token file, IRSA token file -- Phase 38
- ✓ Staging + prod Helm values under `deploy/keeperhub-sandbox/{staging,prod}/`; main app flipped to `SANDBOX_BACKEND=remote` via `deploy/keeperhub/{staging,prod}/values.yaml` -- Phases 38, 39
- ✓ Local minikube live-verification: SA token file ENOENT, IRSA token file ENOENT, planted FAKE_CANARY not reachable via `Error.constructor("return process")()` escape -- Phase 38
- ✓ CI `test-unit-sandbox-remote` job enforces INT-04 (same unit suite passes against both backends) -- Phase 37
- ✓ Retirement PR scaffold + 11-secret rotation runbook delivered as operator artifacts -- Phase 39

### Validated (v1.11)

- ✓ `/hub` consolidated into a tabbed shell (Protocols default / Workflows / Marketplace) with Radix Tabs + `?tab=` URL contract via `router.replace`; hero rewritten to "Hub" -- Phase 44
- ✓ Marketplace tab is a server-component popularity-sorted leaderboard with Drizzle GROUP-BY join wrapped in `unstable_cache(300s)`, cursor pagination LIMIT 50, privacy-whitelisted SELECT (zero leaks of `creatorWalletAddress`/`payerAddress`/`amountUsdc`/`userId`/`organizationId`) -- Phase 44
- ✓ Marketplace sort dropdown shows Popular (default) + Newest only; earnings sort EXPLICITLY ABSENT (deferred to v1.11.x or v1.12) -- Phase 44
- ✓ MCP API + tool symmetry: `GET /api/mcp/workflows?sort=popular|recent` and `search_workflows` MCP tool gain matching `sort` param; tool count unchanged -- Phase 44
- ✓ Anonymous + auto-anonymous Use-template OAuth round-trip via `pending_template` HttpOnly cookie + `PendingTemplateRunner` (NO localStorage) -- Phase 43
- ✓ Deep-link `/hub/tags/[tag]` route with `generateStaticParams` + tag-specific `generateMetadata` + sitemap enumeration + reserved-slug validator (`tags`, `protocol`, `marketplace`, `auth`, `api`, `admin`, `_next`, `og`, `well-known`) -- Phase 43
- ✓ Cards/List view toggle persisted in `hub_view` cookie (server-readable, NO localStorage, zero hydration mismatch); sidebar Sort + Tags reorganization with `useTransition` + `router.push` scroll preservation -- Phase 43
- ✓ Single `WorkflowIOOverlay` (Radix Tabs) replaces split import/export overlays; shared `SignInPromptOverlay` + `useAuthPrompt` hook -- Phase 42
- ✓ Logged-out left-nav with `requireAuth: boolean` per item + `useSession().isPending` first-paint skeleton + `usePersistedNavState` versioning -- Phase 42
- ✓ Import schema hardened (`.passthrough()` -> `.strict()`, `.max()` caps on free-text, https-only webhook URLs, `Content-Length` 413 guard, code-step gate) -- Phase 42
- ✓ Root-layout dev-only `<Script>` (`app/layout.tsx`) supersedes per-page bfcache workaround; detection via `performance.getEntriesByType('navigation')[0]?.type === 'back_forward'`, JSX-gated on `NODE_ENV === 'development'` for full prod DCE -- Phase 45
- ✓ Dual-mode Playwright suite (`pnpm test:e2e:bfcache:{dev,prod}`) + replacement unit test + ADR `specs/architecture/back-forward-hydration.md` -- Phase 45

### Active

_No active milestone — next via `/gsd-new-milestone`._

## Completed Milestone: v1.11 Marketplace Discovery & Hub UX (shipped 2026-05-01)

4 phases (42-45), 42 plans, 3 days. Made listed workflows discoverable across the platform, modernized Hub UX so logged-out users can browse, consolidated workflow import/export into one modal, and shipped the login-gated Use-template CTA.

- **Phase 42 — Foundations:** single `WorkflowIOOverlay` + shared `SignInPromptOverlay` + logged-out left-nav + hardened import schema (KEEP-368, KEEP-297). 9/10 plans complete; Plan 42-10 manual UAT deferred — primitives ride downstream Phase 43/44 verification.
- **Phase 43 — Hub UX:** green Use-template CTA + anonymous OAuth round-trip via `pending_template` cookie, `/hub/tags/[tag]` deep-link with `generateMetadata` + sitemap, Cards/List view toggle in `hub_view` cookie, sidebar Sort+Tags reorg (KEEP-326). UAT GREEN 15/15.
- **Phase 44 — Tabbed Hub:** `/hub` consolidated into Protocols/Workflows/Marketplace tabs with `?tab=` URL contract; Marketplace tab is a popularity-sorted leaderboard with privacy-whitelisted SELECT; MCP API + `search_workflows` tool gain `?sort=popular|recent`; composite `(workflow_id, settled_at)` index reviewed via EXPLAIN and intentionally not added (KEEP-303). UAT GREEN.
- **Phase 45 — Bfcache Fix:** root-layout dev-only `<Script>` supersedes per-page workaround; dual-mode Playwright + ADR. UAT GREEN.

Audit verdict `tech_debt` accepted (`v1.11-MILESTONE-AUDIT.md`): Phase 42 manual UAT (42-10) and Phase 43 retrospective `VERIFICATION.md` remain as documentation tracking debt — phases ARE functionally shipped via downstream verification.

Archived at [milestones/v1.11-ROADMAP.md](milestones/v1.11-ROADMAP.md). Git tag `v1.11` created locally (not pushed to origin).

Deferred / parked: MARKET-FUTURE-01..04 (earnings sort, time-window filters, materialized stats, per-row vote), HUB-FUTURE-02 (per-tag OG images), MARKET-10 SUPERSEDED by HUBV2-08, cross-tab unified search wiring, Marketplace tags column, cross-browser CI runs, upstream Next.js bfcache PR.

## Completed Milestone: v1.9 Code Sandbox Hardening (Minimal) (shipped 2026-04-23)

3 phases (37-39), 3 plans + 2 operator runbooks. Closed the three KEEP-332 exfil paths from the Code action node by moving user JS into a separate `keeperhub-sandbox-{env}` Pod with its own scrubbed ServiceAccount (no RBAC, no IRSA, `automountServiceAccountToken: false` at SA + Pod level). Preserved PR #953's `node:vm` + scrubbed-child-process runner byte-for-byte; added main-app HTTP client with keep-alive `http.Agent`; wired `SANDBOX_BACKEND=local|remote` selector with local default. Live-verified security model on minikube (TEST-01/02/04/05 + INT-04). Staging/prod apply + 24h/7d soak + 11-secret rotation are operator-gated via runbooks in `.planning/phases/{38,39}-*/`. Archived at [milestones/v1.9-ROADMAP.md](milestones/v1.9-ROADMAP.md).

Post-close operator steps: staging apply → 24h soak → prod apply → 7d soak → retirement PR (deletes in-pod runner) → 11-secret rotation → close KEEP-332.

## Previously Current Milestone: v1.9 Code Sandbox Hardening (Minimal)

**Goal:** Close the three known exfil paths from the Code action node (`/proc/<main>/environ`, K8s SA token, IRSA token) with the smallest possible infra + code change. Ship straight away; rotate high-value secrets after prod is stable.

**Target features (trimmed per user direction 2026-04-23):**
- Separate Kubernetes Pod in the **same `keeperhub` namespace** as the main app (different PID namespace via different Pod) — no new namespace, no new cluster environment
- Dedicated ServiceAccount with no RBAC, no IRSA annotation, `automountServiceAccountToken: false` at SA and Pod level — closes K8s SA token and IRSA exfil paths
- Reuse PR #953's `node:vm` + scrubbed-child-process approach verbatim inside the sandbox Pod; the separate Pod plus scrubbed SA delivers the real boundary
- `lib/sandbox-client.ts` in the main app calls the sandbox over intra-cluster HTTP/1.1 with keep-alive; preserves PR #953 v8-serialized base64 + `\x01RESULT\x02` sentinel wire format (BigInt/Date/Map/Set round-trip intact for v1.7 paid-workflow returns)
- `SANDBOX_BACKEND=local|remote` selector — `local` keeps the in-pod child_process path for dev + unit tests, `remote` is the default in staging/prod
- Five-test escape-matrix E2E: `process.env`, `/proc/self/environ`, `/proc/1/environ`, SA token file, IRSA token file — each yields no main-pod secret
- Post-deploy rotation of high-value secrets only (agentic-wallet HMAC with 8-newest-version grace, wallet/integration encryption keys, DB password, better-auth secret, OAuth client secrets, Stripe key, CDP key, Turnkey private key)

**Explicitly out of scope (deferred to v1.9.x or later):**
- NetworkPolicy on metadata hosts / `kubernetes.default.svc` / `sts.*` / internal-DNS — pod-level SA + IRSA removal already stops auth to those targets, and EKS IMDSv2 hop-limit stops pod-to-IMDS in default configurations; revisit if evidence requires it
- `isolated-vm` / true V8 isolate defence-in-depth
- Kyverno/Gatekeeper admission policies
- Node 24 `--permission --allow-fs-read`
- Prometheus metrics + PagerDuty alerts (defer until first incident or first support ticket)
- Warm-pool, per-org budgets, audit log, tracing, public SLO

**Key context:**
- Session threat-model memo (2026-04-23) enumerates the three exfiltration paths PR #953 does not close: `/proc/<parent>/environ`, `/var/run/secrets/kubernetes.io/serviceaccount/token`, `/var/run/secrets/eks.amazonaws.com/serviceaccount/token` + IRSA role ARN
- Linear KEEP-332 (Urgent, assigned to Simon) is the durable-fix ticket; this milestone delivers it
- The main KeeperHub pod's SA cannot be stripped (it uses the SA to create workflow Jobs per `deploy/keeperhub/*/rbac.yaml`), so isolation must come from a separate Pod with its own SA
- No Code-node kill-switch in this milestone — build and deploy the fix straight away; credential rotation happens after deploy
- Performance budget: p99 Code step wall-clock overhead over the current baseline ≤ 300 ms
- PR #953 was closed by user 2026-04-23; the env-scrub + v8-serialization result transport + regression tests from that branch are the reuse floor for the new sandbox on branch `simon/v1.9-sandbox-hardening`

**Linear issues:** KEEP-332

## Previously No Active Milestone (before v1.9)

## Completed Milestone: v1.8 Agentic Wallet for KeeperHub (shipped 2026-04-21)

5 phases (32-36), 21 plans. Agentic wallet product: Turnkey-backed custody, dual-protocol 402 auto-pay (x402 on Base USDC, MPP on Tempo USDC.e, MPP-preferred), three-tier PreToolUse safety hook from `~/.keeperhub/safety.json`, zero-install-scripts supply chain, `npx skills add` distribution, `kh wallet` CLI wrappers, public docs. Archived at [milestones/v1.8-ROADMAP.md](milestones/v1.8-ROADMAP.md).

Post-merge human UAT (16 items across 3 HUMAN-UAT files): staging smoke, npm trusted publisher + skills repo + deploy key setup, kh CLI PR, skills.sh + agentic.market submissions.

## Previously Current Milestone: v1.8 Agentic Wallet for KeeperHub

**Goal:** Ship a KeeperHub-operated agentic wallet product that agents install into their skill directory to pay x402 *and* MPP services, competing with agentcash and Coinbase agentic-wallet-skills on onboarding speed and security.

**Target features:**
- Turnkey-backed key management (non-custodial, TEE-secured, passkey-authenticated) -- materially stronger custody than agentcash's plaintext `~/.agentcash/wallet.json`
- Onboarding-first UX, ideally zero KeeperHub account registration (agent gets a wallet and starts calling services with no signup flow)
- Dual-protocol payment support out of the box: x402 on Base USDC AND MPP on Tempo USDC.e, so one wallet pays any KeeperHub listed workflow regardless of which protocol the caller routed through (symmetric with the v1.7 server surface)
- Skill file + CLI that installs into the same 17 agent skill directories that agentcash / Coinbase skills already support (Claude Code, Cursor, Cline, Windsurf, Continue, Roo Code, Kilo Code, Goose, Trae, Junie, Crush, Kiro CLI, Qwen Code, OpenHands, Gemini CLI, Codex, GitHub Copilot)
- Safety-net-style hook layer intercepting dangerous wallet operations (transfers above threshold, approvals to unknown contracts, unverified address destinations, unusual calldata shapes) with human-in-the-loop confirmation -- borrowing from https://github.com/kenryu42/claude-code-safety-net
- Dogfooding: the KeeperHub wallet is how agents pay KeeperHub paid workflows

**Key context:**
- KEEP-282 holds the agentcash threat-model analysis (plaintext keys, no backup, no passphrase) -- that is our competitive bar on custody
- Turnkey is already integrated for non-agentic wallet flows (`docs/wallet-management/turnkey.md`); this milestone extends that integration to the agentic-wallet use case
- v1.7 shipped the dual-protocol settlement server side (KEEP-176, KEEP-148, KEEP-139, KEEP-261, KEEP-259, KEEP-294). This wallet must be symmetric on the client side
- References: agentic.market, docs.cdp.coinbase.com/x402, agentcash.dev, mppscan.com, https://github.com/kenryu42/claude-code-safety-net

**Linear issues:** KEEP-282

## Deferred Milestone: v1.6 Autonomous Build-Evaluate Loop

Shelved 2026-03-30. Runtime evaluation pipeline for autonomous build/test/iterate. May revisit after v1.7.

## Completed Milestone: v1.7 Agent-Callable Workflows (shipped 2026-04-21)

Agent-callable marketplace: ERC-8004 registration, MCP meta-tools (search_workflows/call_workflow), x402 + MPP dual-protocol settlement, CDP Bazaar discoverability, per-chain earnings dashboard, docs for creators and callers.

## Completed Milestone: v1.5 KeeperHub CLI (shipped v0.4.1, 2026-03-14)

7 phases, 31 plans. Go CLI covering full MCP functionality, MCP server mode, gh-style output, Homebrew distribution.

### Out of Scope

- Shared npm package for schema -- HTTP APIs eliminate need
- Offline mode -- real-time blockchain monitoring is core
- Mobile app -- web-first approach
- Database storage for protocol definitions -- file-based for MVP
- Custom protocol icons -- generic icon, add later per-protocol
- Token metadata auto-detection -- manual decimals for now
- Protocol version management (v2/v3 of same protocol) -- add when needed
- Hub sidebar chain filter -- search only for MVP
- Action pre-insertion into workflow canvas -- navigate only for MVP
- Full 24/7 autonomous agent operation -- tiered autonomy first; expand based on success metrics
- Agent-to-agent direct communication -- Orchestrator mediates all coordination
- Third-party agent frameworks (LangChain, CrewAI) -- Claude Code native agents are simpler

## Context

**Architecture (post v1.4):**
- Main app: Next.js 16 + Drizzle ORM + Vercel AI SDK (monorepo at techops-services/keeperhub)
- Events: Node.js services at techops-services/keeperhub-events (independent deploy)
- Scheduler: TypeScript services at techops-services/keeperhub-scheduler (HTTP-only, independent deploy)
- All services deploy to same K8s cluster (maker-staging/maker-prod, keeperhub namespace)
- Agent team: 5 Claude Code agents (Orchestrator + Builder/Verifier/Researcher/Debugger) in .claude/agents/

**Plugin System:**
- Core plugins: web3, webhook, discord, sendgrid
- Custom plugins in keeperhub/plugins/
- MCP server integration for AI-powered workflow generation
- Agent pipeline automates plugin/protocol/feature creation via /add-protocol, /add-plugin, /add-feature

**Remaining cleanup:**
- PR #195 open for monorepo code removal (stability checklist pending)
- git-filter-repo not yet run (deferred)
- GitHub branch protection on staging not configured (manual GitHub UI)

## Constraints

- **Fork Maintenance**: Custom code in /keeperhub directory with markers in core files
- **Upstream Sync**: Must not break merge path from vercel-labs/workflow-builder-template
- **K8s Deploy**: All services in maker-staging/maker-prod namespaces
- **Lint/Type Safety**: Ultracite/Biome lint + TypeScript strict mode required
- **Agent Safeguards**: 2-round iteration limit, human review for high-risk changes, Verifier approval required

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| HTTP-only for scheduler | Clean separation, no shared schema dependencies | ✓ Good |
| Events extraction first | Already HTTP-only, simpler migration path | ✓ Good |
| Remove git history | Clean repo without legacy service code | -- Pending (deferred) |
| No rollback to monorepo | Clean break reduces complexity | ✓ Good |
| X-Service-Key auth for internal APIs | Simple, effective for service-to-service | ✓ Good |
| Flat directory structure for scheduler | Simpler, no unnecessary nesting | ✓ Good |
| Change detection for scheduler builds | Only rebuild what changed (dispatcher/executor) | ✓ Good |
| `if: false` for disabling old workflows | Preserves rollback capability | ✓ Good |
| outputFileTracingIncludes for @vercel/og | Forces dynamically-imported WASM into standalone output | ✓ Good |
| Drop Phase 6 from v1.1 | Meta tags/social validation deferred to ship core fix faster | ✓ Good |
| File-based protocol definitions | No DB needed, discover-plugins scans at build time | ✓ Good |
| Reuse existing read/write-contract core | Extract to -core.ts pattern, zero new execution code | ✓ Good |
| Generic protocol icon for MVP | Custom icons per-protocol added later | ✓ Good |
| In-memory ABI cache with 24h TTL | Simple, no external cache dependency | ✓ Good |
| Numeric chain ID strings as protocol address keys | Matches chain-select field stored values | ✓ Good |
| Direct execution API over workflows | AI agents think in actions, not workflows | ✓ Good |
| In-memory rate limiting (no Redis) | Simple MVP, sufficient for initial scale | ✓ Good |
| Async execution with polling | Return executionId immediately, poll for result | ✓ Good |
| Reuse F-048 core logic | readContractCore, writeContractCore, resolveAbi already extracted | ✓ Good |
| 5 agents (Orchestrator + 4 workers) | Minimal team -- add agents only when metrics justify coordination overhead | ✓ Good |
| Opus orchestrator, Sonnet workers | Highest reasoning for orchestration, cost-effective for implementation | ✓ Good |
| Tiered autonomy (40/40/20) | Full autonomy only for pattern tasks; human review for features; human-owned for migrations/security | ✓ Good |
| 2-round iteration limit | Escalate to human after 2 failed CI rounds instead of infinite retries | ✓ Good |
| Vitest skill before agents | Agents need verifiable output; unit tests are the verification mechanism | ✓ Good |
| Aave V3 as benchmark | Complex protocol to validate full pipeline end-to-end | -- Pending |
| Standalone Go repo for CLI | Separate from Next.js monorepo, sibling at /cli | ✓ Good |
| XDG via os.Getenv (not adrg/xdg) | Library caches at init, breaks t.Setenv in tests | ✓ Good |
| Factory.HTTPClient returns *khhttp.Client | Version-aware requests with StandardClient() for net/http compat | ✓ Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check -- still the right priority?
3. Audit Out of Scope -- reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-06 -- v1.11 milestone closed (Marketplace Discovery & Hub UX, shipped 2026-05-01); between milestones — next via `/gsd-new-milestone`.*
