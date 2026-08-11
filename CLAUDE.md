# AI Workflow Builder Template (KeeperHub Fork)

## AI Agents Code Policy

- **No Emojis**: NEVER use emojis in any code, documentation, README files, PR descriptions, commit messages, or any other text output. This rule applies to ALL generated content without exception.
- **No File Structure**: Do not include file/folder structure diagrams in README files
- **No Random Documentation**: Do not create markdown documentation files unless explicitly requested by the user. This includes integration guides, feature documentation, or any other .md files
- **`docs/` is public-facing**: The `docs/` directory is published to docs.keeperhub.com. Never put internal specs, notes, or working documents there. Internal documentation and specs go in `specs/`
- **No internal references in public docs**: In `docs/` and `docs-site/content/` (anything published to docs.keeperhub.com), NEVER mention phase numbers (e.g. `Phase 33`), internal version tags (e.g. `v1.8`, `v0.1.4`), Linear ticket IDs (`KEEP-XXX`), PR numbers (`PR #917`), or internal branch names. Write about capabilities in terms of what's supported today vs not yet supported. Internal tracking belongs in `.planning/`, `specs/`, commit messages, and Linear — not on the public docs site.
- **No co-authored with Claude in PR descriptions and git commits**
- **Do not git push or create Github PRs without user's confirmation**
- **Do not leave code comments with summaries of user's prompt**
- **No Linear ticket IDs in code comments, PR titles, or PR descriptions**: Do not include Linear IDs (e.g. `KEEP-XXX`) in code comments, PR titles, or PR descriptions. Linear's GitHub integration cross-links via the branch name; the ticket ID does not need to appear in the artifact. Commit messages and internal docs under `.planning/` / `specs/` may still reference them.
- **PR titles must follow conventional commit format**: `<type>: <description>` or `<type>(scope): <description>`. Allowed types: `feat`, `fix`, `hotfix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`, `perf`, `style`, `breaking`, `release`. This is enforced by the `pr-title-check` workflow on PRs targeting `staging`.
- **Use `kh` CLI and KeeperHub MCP tools for all KeeperHub API interactions**: NEVER use raw `curl` or `fetch` against KeeperHub endpoints. Use MCP tools (`mcp__keeperhub-dev__*`, `mcp__keeperhub-staging__*`, `mcp__keeperhub__*`) for the target environment, or the `kh` CLI which handles auth and CF Access headers automatically via `~/.config/kh/hosts.yml`.

## Code Quality: Lint and Type Checking

**Before writing or editing any code**, review the lint configuration to write compliant code:

1. **Check `biome.jsonc`** for project-specific lint rules and exclusions
2. **Check `.cursor/rules/ultracite.mdc`** for detailed coding standards

### Key Ultracite/Biome Rules

- Use explicit types for function parameters and return values
- Prefer `unknown` over `any`
- Use `for...of` loops over `.forEach()` and indexed loops
- Use optional chaining (`?.`) and nullish coalescing (`??`)
- Use `const` by default, `let` only when reassignment is needed
- Always `await` promises in async functions
- Remove `debugger` and `alert` from all code without exception
- **Logging is context-dependent** — see the Logging section below for the full rule
- Use Next.js `<Image>` component instead of `<img>` tags
- Add `rel="noopener"` when using `target="_blank"`

### Before Every Commit

Run these checks and fix any issues before committing:

```bash
pnpm check      # Lint check (Ultracite/Biome)
pnpm type-check # TypeScript validation
pnpm fix        # Auto-fix lint issues (run if check fails)
```

If `pnpm check` or `pnpm type-check` fails, fix the issues before committing. Do not commit code with lint or type errors.

### Lint Output Caching

When lint/type-check commands run, their output is saved to gitignored files:

- `.claude/lint-output.txt` - Output from `pnpm check`
- `.claude/typecheck-output.txt` - Output from `pnpm type-check`

**Workflow for fixing errors:**

1. Run `pnpm check` or `pnpm type-check` once
2. Read `.claude/lint-output.txt` or `.claude/typecheck-output.txt` for errors
3. Fix the errors in code
4. Re-run the check command only when you need fresh output

**Do NOT** repeatedly run lint commands to check progress. Read the cached output file instead - this saves time and context.

### Claude Hooks (Automatic Checks)

This project has Claude Code hooks configured in `.claude/settings.json`:

**Pre-Edit Lint Context** (`.claude/hooks/pre-edit-lint-context.sh`):

- Fires before Edit/Write on .ts/.tsx/.js/.jsx files
- Injects key Ultracite/Biome lint rules into context
- **Rationale**: Higher upfront token cost, but saves overall context by writing correct code the first time instead of the expensive cycle of: write code → run lint → see errors → fix partially → re-run lint → repeat

**Pre-Commit Checks** (`.claude/hooks/pre-commit-checks.sh`):

- Detects `git commit` commands
- Runs `pnpm check` (lint) and `pnpm type-check` (TypeScript)
- Saves output to `.claude/*.txt` files for reading without re-running
- Blocks the commit (exit code 2) if either fails

### Lint Ignore Comments

**Only use lint ignore comments when absolutely necessary.** Valid reasons:

- Third-party library types are incorrect and cannot be fixed
- Generated code that cannot be modified
- Rare edge cases where the rule genuinely does not apply

**Invalid reasons** (fix the code instead):

- "It works fine"
- "The rule is too strict"
- "It's faster to ignore than fix"

When you must use an ignore comment:

1. Use the most specific ignore possible (target the exact rule, not all rules)
2. Add a brief comment explaining why the ignore is necessary
3. Example:
   ```typescript
   // biome-ignore lint/suspicious/noExplicitAny: third-party SDK types are incomplete
   const result = externalLib.call() as any;
   ```

## Logging

Logging rules differ between server and client code. The Biome `noConsole` rule enforces this boundary: it bans `console.warn/error` on server paths while disabling the rule entirely for `components/**`, `lib/hooks/**`, `app/page.tsx`, `app/workflows/**`, `lib/api-client.ts`, and `tests/**`.

### Server-side (app/api/**, lib/**, app/*/route.ts, scripts/**)

Use the functions from `lib/logging.ts`. Never use `console.warn` or `console.error` on server paths — Biome treats these as errors.

| Function | When to use | Sentry | Prometheus |
|---|---|---|---|
| `logSystemError(category, message, error, labels?)` | Infrastructure/DB/auth failures the system should not encounter | yes (error) | yes |
| `logUserError(category, message, error?, labels?)` | Validation, bad input, external-service rejections caused by the caller | no | yes |
| `logSystemWarn(category, message, error, labels?)` | Recovery events, pre-reconciliation notes, expected fallbacks worth tracking | yes (warning) | no |
| `logInfo(message, labels?)` | State transitions and lifecycle events | no | no |
| `logWarn(message, labels?)` | Benign anomalies that are not operational failures | no | no |
| `logDebug(message, labels?)` | Verbose tracing, gated by `LOG_LEVEL=debug` | no | no |
| `logSecurityEvent(name, fields?, sentry?)` | Security detection signals (KEEP-612) | yes | no |

`ErrorCategory` values: `VALIDATION`, `CONFIGURATION`, `EXTERNAL_SERVICE`, `NETWORK_RPC`, `TRANSACTION`, `BILLING`, `DATABASE`, `AUTH`, `INFRASTRUCTURE`, `WORKFLOW_ENGINE`, `UNKNOWN`.

**Message format**: Use a `[Context] message` prefix. The context string is extracted by regex and becomes the `error_context` label in Loki and Prometheus.

```typescript
// Good
logSystemError(ErrorCategory.DATABASE, "Failed to create workflow", error, {
  endpoint: "/api/workflows/create",
  operation: "create",
});

logUserError(ErrorCategory.VALIDATION, "[Withdraw] Invalid amount", undefined, {
  userId: session.user.id,
});

// Wrong — banned by Biome on server paths
console.error("something broke", error);
console.warn("unexpected state");
```

`console.log/info/debug` are technically allowed by Biome on server paths (the lib/logger facade normalises them to structured JSON) but prefer `logInfo`/`logDebug` so the structured labels and workflow context are included automatically.

### Client-side (components/**, lib/hooks/**, lib/api-client.ts, app/page.tsx, app/workflows/**)

`console.*` is unrestricted — the `noConsole` rule is off for these paths. Logs go to the browser devtools and client-side Sentry; the server observability pipeline (Prometheus, Loki) does not apply.

Use a `[Component]` prefix to match server-side convention and make devtools filtering easy:

```typescript
// Good
console.log("[AI Prompt] Generating workflow", { hasNodes, existingWorkflow: !!existingWorkflow });
console.error("Failed to generate workflow:", error);

// Fine but noisy — keep to meaningful state transitions, not every render
console.log("[AIPrompt] re-render");
```

---

## Design System

Before writing or modifying any UI code, read the relevant spec file in `specs/design-system/`. Use only tokens from `specs/design-system/tokens.css`. Run `node scripts/token-audit.js` before committing UI changes. Zero errors required.

### Key Rules

1. **Read the spec first**: Check `specs/design-system/foundations/` for color, spacing, typography, radius, elevation, and motion tokens. Check `specs/design-system/components/` for component-specific specs.
2. **Use tokens, not raw values**: Never use hardcoded hex colors, rgb/rgba values, or arbitrary pixel values. Reference semantic tokens from `tokens.css`.
3. **Tailwind classes over arbitrary values**: Use `bg-primary`, `text-muted-foreground`, `border-border` instead of `bg-[#xxx]`, `text-[#xxx]`.
4. **Hub-specific dark surfaces**: Use `--color-hub-card`, `--color-hub-icon-bg`, etc. for protocol/hub pages.
5. **Layout constants**: Use `--header-height`, `--flyout-width`, `--sidebar-strip-width` instead of `top-[60px]`, `w-[280px]`, `w-[32px]`.
6. **Token reference**: See `specs/design-system/tokens/token-reference.md` for the complete token map with usage guidance.

### Audit Script

```bash
node scripts/token-audit.js         # Full scan (errors + warnings)
node scripts/token-audit.js --quiet # Errors only
```

Exits with code 1 if errors are found. Errors are hardcoded colors in CSS and arbitrary Tailwind color classes. Warnings are hardcoded spacing, font sizes, z-index, and shadows.

### Exempt Files

- `app/api/og/generate-og.tsx` -- server-rendered OG images, not interactive UI
- `lib/monaco-theme.ts` -- editor syntax highlighting, uses Monaco's theming API
- `docs-site/` -- separate documentation site

---

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript 5
- **UI**: React 19, shadcn/ui, Radix UI, Tailwind CSS 4
- **Database**: PostgreSQL + Drizzle ORM
- **Testing**: Vitest (unit/integration), Playwright (E2E)
- **AI**: Vercel AI SDK with Anthropic/OpenAI
- **Workflow**: Workflow DevKit 4.1.0-beta.51
- **Package Manager**: pnpm

## Project Structure

```
app/              - Next.js app directory (API routes, pages)
components/       - UI components
lib/              - Core utilities, DB schemas, middleware
plugins/          - Workflow plugins (web3, discord, sendgrid, etc.)
scripts/          - Build/migration scripts
tests/            - Test files
specs/            - Internal specs and design system
docs/             - Public-facing docs (published to docs.keeperhub.com)
```

## Common Commands

```bash
pnpm dev                    # Start dev server
pnpm build                  # Production build
pnpm type-check             # TypeScript check
pnpm check / pnpm fix       # Lint

pnpm db:push                # Push schema changes (local dev only)
pnpm db:migrate             # Run file-based migrations
pnpm db:studio              # Open Drizzle Studio

pnpm drizzle-kit generate   # Generate migration file after schema changes

pnpm discover-plugins       # Scan and register plugins
pnpm create-plugin          # Create new plugin

pnpm test                   # All tests
pnpm test:e2e               # E2E tests
```

For codebase exploration, see the "Codebase Understanding" section below — `/understand` and `/understand-dashboard` are Claude Code slash commands, not pnpm scripts.

## Database Migrations

The build script (`scripts/migrate-prod.ts`) runs `pnpm db:migrate` (file-based migrations), **not** `db:push`. Migration state is tracked in the `drizzle.__drizzle_migrations` table (schema `drizzle`, not `public`). When adding or modifying database tables:

1. Update the Drizzle schema (e.g., `lib/db/schema-oauth.ts`)
2. Run `pnpm drizzle-kit generate` to create a migration file in `drizzle/`
3. Ensure the `when` timestamp in `drizzle/meta/_journal.json` is monotonically increasing (each entry must be greater than the previous) -- out-of-order timestamps cause `db:migrate` to fail silently
4. Commit the migration file, snapshot, and journal together with the schema change

Without the migration file, the table will not be created on deploy and you will get `relation does not exist` errors in staging/production.

If your local dev DB was bootstrapped via `pnpm db:push` (instead of file migrations), `pnpm db:migrate` will fail on `relation already exists` because the journal table `drizzle.__drizzle_migrations` is empty. Run `pnpm tsx scripts/backfill-drizzle-migrations.ts` once to mark the existing migrations as applied without re-running their SQL — subsequent `pnpm db:migrate` calls will then cleanly apply only the new files.

Note: a shell-set `DATABASE_URL` overrides the value in `.env` (drizzle.config.ts uses dotenv without `override: true`). If `pnpm db:migrate` connects to the wrong DB or port, run `unset DATABASE_URL` first or prefix the command with the right value.

### Heavy DDL Migrations: the `@requires-db-prep` directive

Some DDL statements cannot run inside a transaction: `CREATE INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, `CREATE DATABASE`, `VACUUM`, certain `ALTER TYPE` forms, etc. `drizzle-kit migrate` wraps every migration in a transaction with no per-file opt-out, so these statements cannot live in a migration file directly.

For changes where the lock-free form matters in production (a plain `CREATE INDEX` on a multi-GB table takes a multi-minute `ACCESS EXCLUSIVE` lock during deploy), we use a directive + branch-protection gate instead of running unsafe DDL through `drizzle-kit migrate`.

**When to use the directive:** any migration whose intent on production is to be applied as `CREATE INDEX CONCURRENTLY` or another statement that cannot be wrapped in a transaction. If the migration only touches small tables and a brief lock is acceptable, you do not need the directive.

**How to author the migration:**

1. Put `-- @requires-db-prep` on the first non-empty line of the SQL file.
2. Write the SQL using the **transaction-safe** form with `IF NOT EXISTS` / `IF EXISTS`. Example:
   ```sql
   -- @requires-db-prep
   -- KEEP-XXX: index on hot column for query Y
   CREATE INDEX IF NOT EXISTS idx_foo_bar ON foo (bar);
   ```
   The `IF NOT EXISTS` clause makes the migration a no-op on prod after step 3 below, and lets it run safely on dev / PR-environment DBs where the table is small.
3. Update `lib/db/schema.ts` (or the matching schema file) to declare the index via the `index()` / `uniqueIndex()` helper, so drizzle-kit does not see it as drift.

**Before merge - operator runbook:**

For each environment the PR will deploy to (staging on PRs to `staging`, prod on staging->prod release PRs):

1. Connect to the target DB.
2. For each statement in the migration, run the **lock-free** form against the real DB. For indexes that is `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...` instead of plain `CREATE INDEX IF NOT EXISTS ...`. Each statement must run individually (not inside a transaction block).
3. Verify there are no INVALID indexes left behind:
   ```sql
   SELECT i.relname FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid WHERE NOT ix.indisvalid;
   -- expect: (0 rows)
   ```
4. If an INVALID index is present (CONCURRENTLY can leave one if a statement errors mid-build), drop it with `DROP INDEX CONCURRENTLY IF EXISTS <name>` and re-run the failing CREATE.
5. Apply the matching label to the PR: `db-prepped-staging` for PRs targeting `staging`, `db-prepped-prod` for PRs targeting `prod`.

**The merge gate:** the `.github/workflows/db-prep-check.yml` workflow scans every PR's diff for newly-added `drizzle/*.sql` files containing the directive. If any are found, the `db-prep-check` status check fails until the matching `db-prepped-<base-branch>` label is set. `db-prep-check` is a required status check in the repo's branch-protection ruleset for `staging`, `prod`, and `main`, so a missing label blocks merge at the GitHub branch-protection layer. PRs without the directive in any added migration pass the check silently.

**On deploy:** because the indexes were already created out-of-band, drizzle-kit's plain `CREATE INDEX IF NOT EXISTS` short-circuits before acquiring any lock and the migration is a true no-op. drizzle-kit records the migration hash in `drizzle.__drizzle_migrations` so future deploys skip it.

Born from the 2026-05-05 RDS CPU incident (KEEP-432).

## Branch Strategy

- **Main branch**: `staging`
- **PRs target**: `staging` (always use `staging` as base branch when creating PRs)
- **Feature branches**: `feature/KEEP-XXXX-description`

---

## Local Dev Sign-in

To get a fresh worktree to a signed-in browser without going through the
signup -> OTP -> MFA -> TOTP UI loop, run one command:

```bash
pnpm dev:login                                # default dev@keeperhub.local
pnpm dev:login some-other@example.com         # any seeded email
```

This bootstraps the DB (idempotent), mints a Better Auth session via the
same helpers (`signSessionCookieValue`, `hashSessionToken`) the production
OAuth-MFA finalize path uses, ensures a dev server is serving
`http://localhost:3000` (reuses one if it is already up, otherwise spawns
`pnpm dev` detached -- logs to `.claude/.dev-server-LOCAL.log` -- and waits
for it to respond), seeds the signed cookie into a Playwright-managed
Chromium profile, and launches Chromium detached at the now-serving URL.
When a server is already running the terminal returns as soon as the
browser launches; on a cold start it blocks until the server is ready. The
Chromium instance has its own user-data-dir under
`.claude/.dev-chrome-profile/`, so it does not touch the user's normal
Chrome.

Lower-level commands for headless / scripted use:

- `pnpm dev:bootstrap` -- DB setup only. Backfills the drizzle journal
  only if the schema was bootstrapped via `db:push`, runs `pnpm db:migrate`,
  seeds the persistent e2e users plus a dev user/org, pre-trusts
  `127.0.0.1` + `::1`, marks the dev user `twoFactorEnabled=true`, binds
  the local `kh` CLI token from `~/.config/kh/hosts.yml`, and upserts 8
  workflow fixtures (Manual/Schedule/Webhook/Event triggers, on+off, plus
  a soft-deleted row).
- `KEEPERHUB_DEV_MINT=1 pnpm dev:mint-cookie <email>` -- mints a cookie
  file at `.claude/.dev-session-cookie-LOCAL` without opening a browser.

**Hard boundaries -- do not relax these:**

- All three scripts refuse to run unless `DATABASE_URL` host is
  `localhost`, `127.0.0.1`, `::1`, `db`, or `postgres`. The standalone
  `dev:mint-cookie` additionally requires `KEEPERHUB_DEV_MINT=1`;
  `dev:login` sets that env var for its mint child because invoking
  `dev:login` is itself the explicit acknowledgement. Do not add other
  bypass envs.
- None of these scripts edit `lib/auth.ts`,
  `lib/auth-session-token-hash.ts` (imported only), or any `app/api/**`
  route. The whole point is to avoid any production runtime change for
  local convenience. If a future task needs to weaken production auth,
  do it in production auth and review it there -- not here.
- `.claude/.dev-session-cookie-LOCAL`, `.claude/.dev-chrome-profile/`, and
  `.claude/.dev-server-LOCAL.log` are gitignored. Do not commit them.

---

## Plugin Development

**Context**: Building Web3 integrations for the workflow system. Plugins go in `plugins/`.

**Current Plugins**: `web3`, `webhook`, `discord`, `sendgrid`

**When creating new plugins**:

1. Check existing plugins: `ls plugins/`
2. Pick a recent, similar plugin as reference
3. Copy its exact structure and pattern
4. Keep it **absolutely minimal** - no extra features, no over-engineering

**Structure**: Each plugin has `index.ts` (definition), `icon.tsx`, `steps/` (actions), optional `credentials.ts` and `test.ts`.

---

## MCP Schemas Endpoint

**Files**:

- `app/api/mcp/schemas/route.ts`

This endpoint serves workflow schemas to the KeeperHub MCP server. It's the source of truth for what actions, triggers, and capabilities are available.

### What's Dynamic (no maintenance needed)

- **Plugin Actions**: Pulled from `getAllIntegrations()` registry - add plugins normally and they appear automatically
- **Chains**: Pulled from database `chains` table - add chains via DB and they appear automatically
- **Platform Capabilities**: Derived by scanning plugin field types (e.g., `abi-with-auto-fetch` → proxy support)

### What's Inline (update when changed)

These are defined directly in the file because they rarely change and aren't in a registry:

| Section           | When to Update                                                     |
| ----------------- | ------------------------------------------------------------------ |
| `SYSTEM_ACTIONS`  | Adding new system action (Condition, HTTP Request, Database Query) |
| `TRIGGERS`        | Adding new trigger type (Manual, Schedule, Webhook, Event)         |
| `TEMPLATE_SYNTAX` | If template syntax `{{@nodeId:Label.field}}` changes               |
| `tips` array      | When adding guidance for AI workflow generation                    |

### How to Update

1. **New System Action**: Add entry to `SYSTEM_ACTIONS` object, implement step in `lib/steps/`
2. **New Trigger**: Add entry to `TRIGGERS` object, implement UI in `components/workflow/config/trigger-config.tsx`
3. **New Plugin**: Just create the plugin normally in `plugins/` - it's picked up automatically

### Testing the Endpoint

```bash
# Get all schemas
curl http://localhost:3000/api/mcp/schemas

# Filter by category
curl http://localhost:3000/api/mcp/schemas?category=web3

# Without chains
curl http://localhost:3000/api/mcp/schemas?includeChains=false
```

---

## Writing Playwright Tests: Discovery-First Workflow

Writing and iterating on E2E tests is an agent-driven loop: discover the page, author against deterministic signals, run with capture, read the failure bundle, fix. Never write selectors from memory. The full guide -- testability signals, `data-*` aliases for reading data back, the agent loop, and the dev-vs-production rule -- lives in [tests/README.md](tests/README.md) (see the "Testability Signals" and "Agent-Driven Test Development" sections).

### Running the test-development agent

The loop is packaged as two project slash commands. Launch Claude Code from the repo root (or a worktree under `.worktrees/`) so the project `.claude/` is loaded, then run:

```
/test-write "<what the test should verify>"   # author a new test, discovery-first
/test-debug <test-file | grep pattern>        # debug a failing test from probe data
```

- **`/test-write`** discovers page structure (`pnpm discover`), reads verified selectors from `.probes/elements.md`, reuses existing `utils/` helpers, writes the test importing from `./fixtures`, runs it, and self-corrects from failure probes (max 3 attempts).
- **`/test-debug`** runs the failing test and classifies the failure from the auto-captured `tests/e2e/playwright/.probes/FAILURE-*` bundle (`elements.md`, `console-logs.txt`, `network-failures.txt`, `screenshot.png`).

Prerequisites: the app and database must be running (infra via `make dev-up`, app on `http://localhost:3000`), and authored tests import from `./fixtures` to get auto-probe-on-failure for free. Develop against `pnpm dev` for the richest signals (source maps, React state); validate production-contract tests against `pnpm build && pnpm start` -- see tests/README.md "Dev vs production runtime".

To investigate, the agent can also reach the app out of band -- the local database (test helpers or psql on `localhost:5433`), the `kh` CLI, and KeeperHub MCP tools (`mcp__keeperhub-dev__*` / `mcp__keeperhub-staging__*`) -- to inspect application state and mutate it to set up or reproduce a scenario. Arrange and verify ground truth out-of-band; assert what the user sees in the browser. See tests/README.md "Inspect and mutate application state".

### Tool 1: Discovery CLI (`pnpm discover`)

Quick recon of any page. Produces structured reports Claude can read.

```bash
# Unauthenticated page
pnpm discover /

# Authenticated (uses persistent test user)
pnpm discover / --auth

# With numbered element overlays on screenshot
pnpm discover / --auth --highlight

# Multi-step exploration
pnpm discover / --auth --steps "click:button:has-text('New Workflow')" "probe:after-click"
```

Output goes to `tests/e2e/playwright/.probes/<label>-<timestamp>/`:

- `screenshot.png` - full page screenshot
- `screenshot-highlighted.png` - elements with numbered overlays (if --highlight)
- `elements.md` - interactive elements table grouped by region (optimized for Claude)
- `report.json` - full structured data
- `summary.txt` - compact overview

### Tool 2: Probe Function (in-test)

Drop `probe()` calls into any test to capture state at specific points:

```typescript
import { probe, highlightElements } from "./utils/discover";

test("my test", async ({ page }) => {
  await page.goto("/");
  await probe(page, "initial"); // captures screenshot + element map

  await page.click('button:has-text("Sign In")');
  await probe(page, "dialog-open"); // captures new state after click

  // Read .probes/ output to understand what's on screen
});
```

### Tool 3: Playwright MCP (direct browser control)

The Playwright MCP server (`.mcp.json`) gives Claude direct browser access. Use it for interactive exploration when the CLI isn't enough:

- Navigate pages, click elements, fill forms
- Take screenshots and read them
- Evaluate JavaScript in the page

Combine with the discovery utilities: use MCP to navigate, then call `getInteractiveElements()` or `getPageStructure()` via page.evaluate for structured data.

### Tool 4: Exploration Test Harness

`tests/e2e/playwright/explore.test.ts` is a scratchpad test designed for iterative exploration:

1. Edit the exploration steps
2. Run: `pnpm test:e2e --grep "explore"`
3. Read probe outputs from `.probes/`
4. Edit steps again based on findings
5. Once page structure is understood, write the real test in a new file

### Recommended Workflow for Writing New Tests

1. **Recon**: Run `pnpm discover <path> --auth --highlight` to understand the page
2. **Read**: Read the `elements.md` output to see available selectors
3. **Explore**: If you need to interact (open dialogs, expand menus), use the explore harness or Playwright MCP
4. **Write**: Create the real test file using the selectors and interaction patterns discovered
5. **Verify**: Run the test, use `probe()` at failure points if it breaks

### Key Selectors Reference

| Element         | Selector                             |
| --------------- | ------------------------------------ |
| Sign In button  | `button:has-text("Sign In")` (first) |
| Auth dialog     | `[role="dialog"]`                    |
| Signup email    | `#signup-email`                      |
| Signup password | `#signup-password`                   |
| OTP input       | `#otp`                               |
| User menu       | `[data-testid="user-menu"]`          |
| Workflow canvas | `[data-testid="workflow-canvas"]`    |
| Trigger node    | `.react-flow__node-trigger`          |
| Action grid     | `[data-testid="action-grid"]`        |
| Add Step button | `button[name="Add Step"]`            |
| Toasts          | `[data-sonner-toast]`                |
| Org switcher    | `button[role="combobox"]`            |

### Existing Test Utilities

| Utility                        | Import             | Purpose                             |
| ------------------------------ | ------------------ | ----------------------------------- |
| `signUpAndVerify(page)`        | `./utils/auth`     | Full signup + OTP verification flow |
| `signIn(page, email, pw)`      | `./utils/auth`     | Sign in with credentials            |
| `createWorkflow(page)`         | `./utils/workflow` | Navigate + create new workflow      |
| `addActionNode(page, label)`   | `./utils/workflow` | Add action to canvas                |
| `probe(page, label)`           | `./utils/discover` | Capture page state for analysis     |
| `highlightElements(page)`      | `./utils/discover` | Add numbered overlays               |
| `getInteractiveElements(page)` | `./utils/discover` | Get structured element list         |
| `getPageStructure(page)`       | `./utils/discover` | Get page headings, landmarks, forms |
| `createTestWorkflow(email)`    | `./utils/db`       | Inject workflow directly into DB    |

---

## Codebase Understanding (Understand-Anything)

The repo uses [Understand-Anything](https://github.com/Lum1104/Understand-Anything) — a Claude Code plugin that produces a queryable knowledge graph of the codebase plus an interactive force-directed dashboard.

### When to reach for it

- **Onboarding** into `plugins/`, `lib/`, or `app/api/`: start with `/understand-onboard` instead of `ls` + grep.
- **Cross-system debugging** (executor + SDK + DB bugs that span subsystems): `/understand-diff` shows structural impact of in-flight changes.
- **Pre-PR review** for diffs that touch shared `lib/` or multiple plugins.

Skip it for plugin-local PRs, design-system work, or Drizzle migration ordering bugs — reading the live code is faster.

### Install (one-time, per developer)

In a fresh Claude Code session at the repo root:

```
/plugin marketplace add Lum1104/Understand-Anything
/plugin install understand-anything
```

Restart Claude Code. The post-commit auto-update hook is **off** in this repo's `config.json` on purpose — auto-update couples the graph to every commit and pollutes PR diffs with regenerated JSON. Refresh on cadence instead (see "Update process" below). If you want personal incremental updates that you'll squash before pushing, enable it locally with `/understand --auto-update`.

### Daily usage

```
/understand plugins/      # scope a first-time analysis to a subtree
/understand-dashboard     # open the interactive graph at http://127.0.0.1:5173
/understand-chat ...      # Q&A over the graph
/understand-diff          # impact analysis of uncommitted changes
/understand-onboard       # guided tour for a new contributor
/understand-explain ...   # explain a file/function in context
/understand-domain        # business-domain grouping view
```

Run a fresh full index after large refactors or after pulling new `staging`:

```
/understand --full
```

### Update process

- **Plugin itself**: `/plugin marketplace update understand-anything` (run periodically; harmless if no update is available).
- **Knowledge graph**: refresh weekly with `/understand` (incremental — only re-analyzes changed files) and after wide-blast-radius refactors with `/understand --full`. Auto-update is off (see above) to keep PR diffs clean. Refresh PRs land as their own commit, never bundled into feature PRs.

### Output and gitignore

- `.understand-anything/knowledge-graph.json` — **committed**; the dashboard reads this so the next person doesn't have to re-run a full index.
- `.understand-anything/intermediate/` and `.understand-anything/diff-overlay.json` — gitignored (scratch + local diff state).

For graphs over ~10MB, use git-lfs.

### Gotchas specific to this repo

- **tsconfig path aliases**: KeeperHub's `@/*` aliases can be dropped by the indexer (upstream issue #214). After the first run, verify the graph has edges into `@/components`, `@/lib`, and `@/plugins`. If missing, re-run `/understand --full` after the upstream fix lands.
- **Dashboard port `5173`**: Vite's default. If another Vite project is already running, the dashboard URL will silently serve the wrong app — kill the other one first.
- **VS Code Copilot Chat 0.48.1**: known incompatibility (upstream issue #218); use Claude Code as the host instead.
