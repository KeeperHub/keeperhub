# Contributing to KeeperHub

Contribution guide for the KeeperHub workflow automation platform.

## Start with an issue

Anything that changes behaviour needs an issue first, accepted by a maintainer,
before the pull request. **[ISSUES.md](ISSUES.md) is the policy** - what needs an
issue, what goes straight to a pull request, and what happens after you file one.

The short version: open an issue, wait for the `accepted` label, then reference
it from your pull request - in the title (`fix: #1978 description`), as
`Closes #1978` in the description, or in an `issue-1978` branch name. Typos,
broken links, formatting, and docs corrected to match existing behaviour skip
all of that.

## Table of Contents

- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Plugin Development Guide](#plugin-development-guide)
- [Protocols and Contract Addresses](#protocols-and-contract-addresses)
- [Adding a Chain](#adding-a-chain)
- [Testing Guidelines](#testing-guidelines)

## Development Setup

### Prerequisites

- Node.js 24+ (see `.node-version`)
- pnpm (package manager)
- PostgreSQL 16+
- Docker and Docker Compose

### Environment Variables

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

See `.env.example` for the complete list of available environment variables.

### Local Development (No Docker)

For UI/API development without Docker:

```bash
pnpm install
pnpm db:push
pnpm dev
```

Visit http://localhost:3000.

### Docker Compose Development

Full development stack with scheduled workflow execution:

```bash
make dev-setup    # First time (starts services + migrations)
make dev-up       # Subsequent starts
make dev-logs     # View logs
make dev-down     # Stop services
```

Services: PostgreSQL (5433), LocalStack SQS (4566), KeeperHub App (3000), Schedule Dispatcher, Executor, Redis.

### Hybrid Mode with K8s Jobs

For testing workflow execution in isolated K8s Job containers:

```bash
make hybrid-setup     # Full setup
make hybrid-status    # View status
make hybrid-down      # Teardown
```

## Development Workflow

1. Create a branch following the naming convention:

   ```bash
   git checkout -b feat/KEEP-123-description
   ```

   That is the team's shape, with the Linear ticket in the branch name. Outside
   contributors have no ticket: name the branch after the issue
   (`fix/issue-1978-description`) or however you like, and put the issue number
   in the pull request title.

2. Make your changes and test thoroughly

3. Run quality checks:

   ```bash
   pnpm check       # Lint check (Ultracite/Biome)
   pnpm type-check  # TypeScript validation
   pnpm fix         # Auto-fix lint issues
   ```

4. Commit using conventional commit format:

   ```bash
   git commit -m "feat: KEEP-123 add new feature"
   ```

   Types: `feat`, `fix`, `hotfix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`, `perf`, `style`, `breaking`

5. Push and create a pull request targeting `staging`

## Pull Request Process

### Before Submitting

- The backing issue carries the `accepted` label, or the change is on the
  no-issue-required list in [ISSUES.md](ISSUES.md)
- All tests pass
- Code passes lint (`pnpm check`) and type check (`pnpm type-check`)
- Changes are tested thoroughly
- No secrets, `.env` files, or credentials committed
- Every on-chain address the pull request adds carries its evidence - see
  [Protocols and Contract Addresses](#protocols-and-contract-addresses)

### PR Guidelines

1. **Title**: Conventional commit format, `<type>: <description>` or `<type>(scope): <description>`, enforced by the `pr-title-check` workflow. Outside contributions put the accepted issue number after the type (`fix: #1978 description`); the `pr-issue-link` check also accepts `Closes #1978` in the description or an `issue-1978` branch name, and fails a pull request that has none of them with a comment saying what is missing. Internal work carries its Linear ticket in the branch name instead (`feat/KEEP-1234-description`)
2. **Base branch**: Always target `staging`
3. **Description**: Explain what and why, not just how
4. **Scope**: One change per pull request. If a part of it could ship and be correct with the rest reverted, split it
5. **Screenshots**: Include for UI changes - before and after, and each state the change touches

### Deploy Verification

Every PR needs production proof after merge:
1. Deploy to staging, verify
2. Deploy to production
3. Document with screenshot/recording

## Plugin Development Guide

### Plugin System Overview

Plugins extend workflow capabilities. Each plugin is self-contained in `plugins/{name}/`:

```
plugins/my-integration/
  index.ts          # Plugin definition
  icon.tsx          # Icon component (SVG or Lucide)
  credentials.ts    # Credential type definition
  test.ts           # Connection test function
  steps/            # Action implementations
    my-action.ts    # Step function with "use step" directive
```

Current plugins: `web3`, `discord`, `sendgrid`, `slack`, `telegram`, `webhook`, `code`, `math`, `protocol`, `safe`, `linear`.

### Quick Start

```bash
pnpm create-plugin
```

This launches an interactive wizard that creates the full plugin structure. After creation:

```bash
pnpm discover-plugins  # Register the plugin
pnpm dev               # Test it
```

### Reference Plugins

- `plugins/web3/` - Full-featured plugin with multiple actions, credential handling, and read/write operations
- `plugins/discord/` - Simpler notification plugin
- `plugins/_template/` - Minimal template files

### Step File Rules

The `"use step"` directive marks a file for workflow bundler processing. Critical rules:

1. **Never export functions from step files** other than the step function itself, `_integrationType`, and types
2. **To share logic between steps**: extract into a `*-core.ts` file (no `"use step"`)
3. **No Node.js-only SDKs** in step files -- use `safeFetch()` from `@/lib/safe-fetch` for HTTP calls, not the raw `fetch` global. Bare `fetch`, `axios`, and `http.request` under `plugins/` are rejected by the `Forbid raw network egress in plugins` check, which excludes `*.test.ts`, `plugins/*/test.ts`, `*.md` and `*.txt`. Connection tests and test files use the raw `fetch` global; connection tests are guarded instead by `assertUrlIsPublic`, which `handlePluginTest` applies to user-supplied URL fields before the test runs

See `plugins/CLAUDE.md` for the complete step file specification.

### Plugin Registration

After adding or modifying plugins:

```bash
pnpm discover-plugins
```

This auto-generates `lib/step-registry.ts` and `lib/codegen-registry.ts` (both gitignored).

### Plugin Allowlist

`plugins/plugin-allowlist.json` controls which plugins are enabled. If the file is absent, all discovered plugins are enabled.

## Protocols and Contract Addresses

A wrong contract address is not caught by anything else here.
`tests/unit/protocol-<slug>.test.ts` asserts that an address matches
`^0x[0-9a-fA-F]{40}$` - that it is well formed, not that code is deployed at it
on the chain claimed. Type-check and lint have nothing to say about it either.

The cost of getting it wrong is not a failed build. An action's `network` field
takes its `allowedChainIds` straight from `Object.keys(contract.addresses)`
(`lib/protocol-registry.ts:395`), so a chain listed there is a chain users can
pick in the builder. If the protocol is not deployed on it, every call reverts,
for every user who picks it, in production.

So the evidence travels with the address.

### What needs evidence

- A new protocol in `protocols/`
- A new chain added to an existing protocol's `addresses` map
- A changed contract address, ABI, or protocol version
- A new token in `lib/test-data/chain-test-data.ts`
- An address named in docs, a plugin, or an example

### What the evidence is

**Every address**: where it came from, and it has to be somewhere
authoritative - the protocol team's own documentation or published address list,
their official repository, or a verified contract on the block explorer. Link
that source in the pull request description. A blog post, a tutorial, an
aggregator or a chat message is not a source. The page must be for the version
you are adding - a V3 ABI taken from a V4 contract page compiles, passes unit
tests, and fails on chain with `INVALID_ARGUMENT` or `BAD_DATA`.

**Never add a chain the protocol is not deployed on.** Not to make local testing
easier, not to fill out the map. If there is no testnet deployment, the
integration test forks mainnet - it does not get a fabricated testnet entry.

**Every ABI**: the exact source URL and the version it corresponds to. In order
of preference: an npm package published by the protocol team for that version,
a verified contract on the block explorer, the protocol's GitHub repository
pinned to the version's tag (not `main`), the official docs. If no ABI source
exists anywhere, say so in the description rather than hand-writing fragments.

**Every version**: one version per protocol entry. Do not mix V3 and V4
contracts. Where a version has sub-surfaces - Aave V4 Hub against Spoke,
Uniswap V3 SwapRouter02 against SwapRouter - name the exact surface in the
contract label.

**Every token**: the address from a block explorer, and the decimals confirmed
by calling the token contract's `decimals()` on the target chain. Do not infer
decimals from the symbol or copy them from the explorer's metadata field. Both
are wrong often enough to break every workflow that touches the token, and
`chain-test-data.ts` is shared by every protocol that uses it. USDC is 6, not
18.

Updating an existing protocol is held to the same standard, for whatever the
change touches. An address that is already in the repository has been through
this once; one you are changing has not.

### The contracts-checked gate

`.github/workflows/contracts-checked.yml` scans the lines a pull request adds
for Ethereum and Solana addresses and fails until a maintainer applies the
`contracts-checked` label. The label is their attestation that each address
matches the authoritative source cited for it. Making that call is their job;
giving them a source to check it against is yours.

See what it will find before you push:

```bash
node scripts/scan-contract-addresses.mjs --base origin/staging --head HEAD
```

The scan skips lockfiles and generated output, skips addresses that already
exist on `staging`, and skips zero-dominated fixtures like
`0x00000000000000000000000000000000000000a1`. A Solana candidate counts only if
it base58-decodes to exactly 32 bytes.

It fires on test fixtures and documentation examples too, which is intended -
an address in a guide is one a reader may send funds to. If the addresses in
your pull request are fixtures, say so in the description; that is all the
reviewer needs to clear the label.

## Adding a Chain

A chain touches nine places in this repository before it works end to end,
and the ones that are easy to miss fail quietly: an explorer config that is
never written, a wallet modal that prints "Not available" next to real
tokens, an Event trigger that saves and never fires. The full procedure, with
what each step is for and how to verify it, is in
[specs/adding-an-evm-chain.md](specs/adding-an-evm-chain.md). Read it before
opening the issue; the facts it asks for are the facts the issue needs.

Your pull request ends at this repository. Private RPC endpoints and
per-environment overrides live in `KeeperHub/chain-config` and are wired by
maintainers after merge; an entry there for a chain this repository does not
know does nothing.

## Testing Guidelines

### Running Tests

```bash
pnpm test              # All unit tests
pnpm test:unit         # Unit tests only
pnpm test:integration  # Integration tests
pnpm test:e2e          # Playwright E2E tests
```

### Quality Checks

```bash
pnpm check             # Lint (Ultracite/Biome)
pnpm type-check        # TypeScript validation
pnpm fix               # Auto-fix lint issues
```

### Integration Testing Checklist

- Connection test validates credentials correctly
- Action executes successfully in a workflow
- Invalid credentials show helpful error messages
- Template variables (`{{NodeName.field}}`) work correctly
- Edge cases tested with missing/invalid inputs

### E2E Test Discovery

Use the discovery tools to understand page structure before writing Playwright tests:

```bash
pnpm discover /path --auth --highlight
```

See the E2E testing section in `CLAUDE.md` for the full discovery-first workflow.
