# KeeperHub

A Web3 workflow automation platform that enables users **and Agents** to create, manage, and execute blockchain automation workflows and tasks. Supports smart contract monitoring, token transfers, DeFi operations, and integrations with Discord, SendGrid, webhooks and more.

## Core Value

Users and Agents can build and deploy Web3 automation workflows through a visual builder or via the [MCP server](https://docs.keeperhub.com/ai-tools/mcp-server) without writing code.

## Add KeeperHub to your Agent

**Quick setup (no install needed):**

```bash
claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp
```

Then run `/mcp` inside Claude Code to authorize via browser. That's it.

Try asking Claude to "create a workflow that monitors a wallet".

**Alternative: install the Claude Code plugin** for skills and slash commands:

```bash
/plugin marketplace add KeeperHub/claude-plugins
/plugin install keeperhub@keeperhub-plugins
/keeperhub:login
```

Restart Claude Code after setup. [Plugin source code](https://github.com/KeeperHub/claude-plugins/tree/main/plugins/keeperhub).

## What KeeperHub Does

- **Visual Workflow Builder**: Drag-and-drop interface for building blockchain automations
- **Smart Contract Interactions**: Read and write to smart contracts without writing code
- **Multi-Chain Support**: Ethereum Mainnet, Sepolia, Base, Arbitrum, and more
- **Secure Wallet Management**: Turnkey secure-enclave wallets with no private key exposure
- **Notifications**: Email, Discord, Slack, and webhook integrations
- **Scheduling**: Cron-based, event-driven, webhook, or manual triggers
- **AI-Assisted Building**: Describe automations in plain language

## Key Features

### Triggers

- **Scheduled**: Run at intervals (every 5 minutes, hourly, daily, custom cron)
- **Webhook**: Execute when external services call your workflow URL
- **Event**: React to blockchain events (token transfers, contract state changes)
- **Manual**: On-demand execution via UI or API

### Actions

- **Web3**: Check Balance, Read Contract, Write Contract, Transfer Funds, Transfer Tokens
- **Notifications**: Send Email, Discord Message, Slack Message, Telegram Message
- **Integrations**: Send Webhook, custom HTTP requests

### Conditions

- Low balance detection
- Value comparisons
- Custom logic with AND/OR operators

## Development Setup

### Prerequisites

- Node.js 24 (see `.node-version`; every Docker stage builds on `node:24-alpine`)
- pnpm package manager
- PostgreSQL 16 (only for "Local Development" mode below; Docker and Hybrid modes start their own Postgres in a container)
- Docker Engine with the Compose plugin (only for Docker and Hybrid modes)
- A LocalStack auth token (only for Docker and Hybrid modes; the compose file uses the Pro image and refuses to boot without it). Free dev tokens are available at https://app.localstack.cloud.

### Environment Variables

Copy `.env.example` to `.env` and fill in the keys you need. Use `.env`, not `.env.local`: `drizzle-kit` (used by `pnpm db:push`) reads `.env` only.

The minimum keys needed to boot the dev server are:

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/keeperhub

# Authentication
BETTER_AUTH_SECRET=your-secret-key
BETTER_AUTH_URL=http://localhost:3000

# Required for Docker and Hybrid modes (LocalStack Pro license)
LOCALSTACK_AUTH_TOKEN=your-localstack-token
```

Feature-specific keys (AI, wallets, encryption, OAuth providers, etc.) are listed in `.env.example` and only need values when you exercise that feature.

### Installation

```bash
pnpm install
pnpm db:push
pnpm dev
```

Visit [http://localhost:3000](http://localhost:3000) to get started. The first request triggers a Next.js dev compile that can take 30-60 seconds; subsequent requests are fast.

### Local development troubleshooting

- **`pnpm dev:login` fails after `pnpm db:push`:** Your schema is ahead of the Drizzle migration journal. `dev:bootstrap` (invoked by `dev:login`) backfills the journal before migrating when the `users` table exists and the journal is empty. If a migration then fails because an object it creates already exists, while the journal still lags the schema, bootstrap marks every journal entry applied and retries once. `db:push` applies your whole working-tree schema, so that is the right set - but if you pulled migrations authored since your last push, run `pnpm db:push` again so their SQL is actually applied. Manual fallback: `pnpm tsx scripts/backfill-drizzle-migrations.ts`, then retry.
- **`db:push` vs `db:migrate`:** Use `pnpm db:push` only for fast local schema iteration. Staging and production apply file-based migrations via `pnpm db:migrate` on deploy.
- **Local Postgres required:** `dev:login` and `dev:bootstrap` refuse to run unless `DATABASE_URL` points at a local host (for example `postgresql://postgres:postgres@localhost:5433/keeperhub` when using Docker Compose).

## Running Modes

### Local Development (Simplest)

For UI/API development without Docker. Requires PostgreSQL running on the host.

```bash
pnpm install
pnpm db:push
pnpm dev
```

### Dev Mode with Docker

Full development stack with scheduled workflow execution.

The compose file declares four resources as `external: true`. Create them once before the first `make dev-setup`:

```bash
docker network create keeperhub-network
docker volume create keeperhub_db_data
docker volume create keeperhub_node_modules
docker volume create keeperhub_localstack_data
```

Then:

```bash
make dev-setup    # First time (starts services + migrations)
make dev-up       # Subsequent starts
make dev-logs     # View logs
make dev-down     # Stop services
```

Services: PostgreSQL (5433), LocalStack SQS (4566), Redis (6379), KeeperHub App (3000), Scheduler, Block Dispatcher, Event Tracker, Executor.

### Hybrid Mode with K8s Jobs

For testing workflow execution in isolated K8s Job containers. Requires Docker, `kubectl` and `minikube` on the host. Run as a regular user, **not** root - Minikube refuses the docker driver under root.

Create the same four external Docker resources as for Dev mode (see above) before the first run:

```bash
docker network create keeperhub-network
docker volume create keeperhub_db_data
docker volume create keeperhub_node_modules
docker volume create keeperhub_localstack_data
```

Then:

```bash
make hybrid-setup     # Full setup
make hybrid-status    # View status
make hybrid-down      # Teardown
```

## Common Commands

```bash
# Development
pnpm dev              # Start dev server
pnpm build            # Production build
pnpm type-check       # TypeScript check
pnpm check            # Run linter
pnpm fix              # Fix linting issues

# Database
pnpm db:push          # Push schema changes
pnpm db:studio        # Open Drizzle Studio
pnpm db:seed          # Seed chain data

# Plugins
pnpm discover-plugins # Scan and register plugins
pnpm create-plugin    # Create new plugin

# Testing
pnpm test             # Run all tests
pnpm test:e2e         # E2E tests
```

## Codebase Understanding

This repo ships an [Understand-Anything](https://github.com/Lum1104/Understand-Anything) knowledge graph at `.understand-anything/knowledge-graph.json` plus a Claude Code plugin for exploring it. The graph is a structural map of files, functions, imports, and architectural layers; the dashboard is a force-directed visualization.

**Install (one-time, per developer):** in Claude Code at the repo root:

```
/plugin marketplace add Lum1104/Understand-Anything
/plugin install understand-anything
```

Restart Claude Code, then:

```
/understand-dashboard           # interactive graph at http://127.0.0.1:5173
/understand-chat <question>     # Q&A over the graph
/understand-diff                # impact analysis of uncommitted changes
/understand-onboard             # guided tour for new contributors
/understand --full              # full re-index after a large refactor
```

Auto-refresh on commit is intentionally **off** in this repo (it would couple the graph to every PR diff). Refresh on cadence: weekly `/understand` for incremental, `/understand --full` after wide-blast-radius refactors. See `CLAUDE.md` for when each command is most useful and the known caveats.

## Architecture

### Services

#### Long-running

| Service | Description | Source |
|---------|-------------|--------|
| **App** | Next.js application with workflow builder UI and API | `app/`, `keeperhub/` |
| **Schedule Dispatcher** | Evaluates cron schedules every minute, dispatches matching workflows to SQS | `keeperhub-scheduler/schedule-dispatcher/` |
| **Block Dispatcher** | Monitors blockchain blocks via WebSocket, dispatches matching workflows to SQS | `keeperhub-scheduler/block-dispatcher/` |
| **Event Tracker** | Monitors blockchain events via Redis streams and routes to SQS | `keeperhub-events/event-tracker/` |
| **Executor** | Polls SQS for all trigger types, executes workflows in-process or as K8s Jobs | `keeperhub-executor/` |
| **Sandbox** | WASM-isolated JavaScript runtime for safe user code execution | `deploy/keeperhub-sandbox/` |
| **Metrics Collector** | Aggregates and exposes per-execution Prometheus metrics from workflow runner pods | `keeperhub-metrics-collector/` |

#### Ephemeral

| Service | Description | Source |
|---------|-------------|--------|
| **Workflow Runner** | Short-lived K8s Job container that executes a single workflow in isolation | `keeperhub-executor/workflow-runner.ts` |
| **Reaper** | K8s CronJob (every 10 min) that cleans up stale in-progress executions | `deploy/scripts/reaper.sh` |
| **Execution Digest** | K8s CronJob (daily 14:00 UTC) that sends weekly execution digest emails | `deploy/scripts/digest-cron.sh` |

All trigger services (schedule dispatcher, block dispatcher, event tracker) send messages to a shared SQS queue. The executor consumes from this queue and runs workflows in isolated K8s Job containers using the workflow-runner image. The execution mode is configurable via `EXECUTION_MODE`: `isolated` (default, all workflows in K8s Jobs), `complex` (K8s Jobs for web3 writes, in-process for everything else), or `process` (all in-process, no K8s).

### Tech Stack

- **Framework**: Next.js 16 (App Router) with React 19
- **Language**: TypeScript 5
- **UI**: shadcn/ui, Radix UI, Tailwind CSS 4
- **Database**: PostgreSQL with Drizzle ORM
- **Workflow Engine**: Workflow DevKit
- **Authentication**: Better Auth
- **AI**: Vercel AI SDK (OpenAI/Anthropic)
- **Wallets**: Turnkey secure-enclave integration

### Plugin System

Plugins extend workflow capabilities. Located in `keeperhub/plugins/`:

- `web3` - Blockchain operations (balance, transfers, contract calls)
- `discord` - Discord notifications
- `sendgrid` - Email via SendGrid
- `webhook` - HTTP integrations
- `telegram` - Telegram notifications

## API

Base URL: `https://app.keeperhub.com/api`

### Endpoints

| Resource                         | Description        |
| -------------------------------- | ------------------ |
| `/api/workflows`                 | CRUD for workflows |
| `/api/workflows/{id}/execute`    | Execute a workflow |
| `/api/workflows/{id}/executions` | Execution history  |
| `/api/integrations`              | Manage connections |
| `/api/chains`                    | Supported networks |

See [API Documentation](docs/api/index.md) for full reference.

## Observability

Prometheus metrics exposed at `/api/metrics`:

- Workflow execution performance
- API latency
- Plugin action metrics
- User and organization stats

See [Metrics Reference](keeperhub/lib/metrics/METRICS_REFERENCE.md) for details.

## Documentation

Full documentation available at [docs.keeperhub.com](https://docs.keeperhub.com) or in the `docs/` directory:

- [Quick Start Guide](docs/getting-started/quickstart.md)
- [Core Concepts](docs/intro/concepts.md)
- [Workflow Examples](docs/workflows/examples.md)
- [API Reference](docs/api/index.md)
- [Security Best Practices](docs/practices/security.md)

## License

Apache 2.0
