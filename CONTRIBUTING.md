# Contributing to KeeperHub

Contribution guide for the KeeperHub workflow automation platform.

## Start with an issue

Anything that changes behaviour needs an issue first, accepted by a maintainer,
before the pull request. **[ISSUES.md](ISSUES.md) is the policy** - what needs an
issue, what goes straight to a pull request, and what happens after you file one.

The short version: open an issue, wait for the `accepted` label, then reference
it in your pull request title (`fix: #1978 description`). Typos, broken links,
formatting, and docs corrected to match existing behaviour skip all of that.

## Table of Contents

- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Plugin Development Guide](#plugin-development-guide)
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

### PR Guidelines

1. **Title**: Conventional commit format carrying the reference, `<type>: #<issue> <description>` or `<type>(scope): #<issue> <description>`. Internal work uses its Linear code in the same position (`feat: KEEP-1234 description`); outside contributions use the GitHub issue number (`fix: #1978 description`). Enforced by the `pr-title-check` and `pr-issue-link` workflows
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
3. **No Node.js-only SDKs** in step files -- use `fetch()` for HTTP calls

See `plugins/CLAUDE.md` for the complete step file specification.

### Plugin Registration

After adding or modifying plugins:

```bash
pnpm discover-plugins
```

This auto-generates `lib/step-registry.ts` and `lib/codegen-registry.ts` (both gitignored).

### Plugin Allowlist

`plugins/plugin-allowlist.json` controls which plugins are enabled. If the file is absent, all discovered plugins are enabled.

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
