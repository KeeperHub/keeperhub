# KeeperHub Events System

A comprehensive event tracking and processing system for the KeeperHub smart contract platform, built on Node.js with Docker and Kubernetes deployment support.

## Overview

This repository contains two main services:

- **event-tracker**: Monitors blockchain events and synchronizes them with the system

The system is designed to run in multiple deployment modes: local development, Docker Compose (with hybrid Minikube support), and full Kubernetes production environments.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Docker Compose Network                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────┐  │
│  │  sc-event-      │    │  sc-event-      │    │    Redis    │  │
│  │  tracker        │───▶│  worker         │    │   (sync)    │  │
│  │                 │    │  :3010          │    │   :6379     │  │
│  └────────┬────────┘    └────────┬────────┘    └──────▲──────┘  │
│           │                      │                     │         │
│           │                      │                     │         │
│           └──────────────────────┼─────────────────────┘         │
│                                  │                               │
└──────────────────────────────────┼───────────────────────────────┘
                                   │
                                   ▼
                          ┌─────────────────┐
                          │  KeeperHub API  │
                          │   (external)    │
                          └─────────────────┘
```

## Quick Start with Docker Compose

### Prerequisites

- Docker and Docker Compose installed
- Access to KeeperHub API credentials

### Setup

1. **Clone the repository and navigate to the project directory:**

   ```bash
   cd keeperhub-events
   ```

2. **Create your environment file:**

   ```bash
   cp .env.docker .env
   ```

3. **Edit `.env` with your configuration:**

   ```bash
   # Required variables:
   KEEPERHUB_API_URL=https://api.keeperhub.example.com
   INTERNAL_SERVICE_HMAC_SECRET=your-internal-service-hmac-secret
   JWT_TOKEN_USERNAME=your-username
   JWT_TOKEN_PASSWORD=your-password
   ETHERSCAN_API_KEY=your-etherscan-key
   ```

4. **Start all services:**

   ```bash
   docker-compose up -d
   ```

5. **Check service status:**
   ```bash
   docker-compose ps
   ```

### Docker Compose Commands

| Command                                   | Description                      |
| ----------------------------------------- | -------------------------------- |
| `docker-compose up -d`                    | Start all services in background |
| `docker-compose down`                     | Stop and remove all containers   |
| `docker-compose logs -f`                  | Follow logs from all services    |
| `docker-compose logs -f event-tracker` | Follow tracker logs              |
| `docker-compose restart`                  | Restart all services             |
| `docker-compose build --no-cache`         | Rebuild images without cache     |

### Services

| Service            | Port | Description                                         |
| ------------------ | ---- | --------------------------------------------------- |
| `redis`            | 6379 | Redis for synchronization between tracker instances |
| `event-tracker` | -    | Monitors blockchain events                          |

### Environment Variables

See [`.env.docker`](.env.docker) for a complete list of configurable environment variables.

## The Trace trigger

The Trace trigger matches raw call frames out of `debug_traceBlockByNumber`
(`callTracer`), which is what lets a workflow see the things `eth_getLogs`
cannot: reverted drain attempts, internal ETH transfers, `delegatecall` into an
unlogged implementation, and unlogged privileged calls. Two operational
properties of it do not follow from the trigger's configuration and are worth
knowing before enabling it.

### Not every chain can serve it

`debug_traceBlockByNumber` is a debug-namespace method. The in-repo survey at
`.planning/issue-2247-trace-upstream-survey.md` probed it against every chain in
the app's `CHAIN_CONFIG` / `PUBLIC_RPCS` and found it **unavailable** on the
public defaults for Ethereum, Base, Arbitrum, Polygon, BNB, OP and Avalanche,
and **available** on Plasma and Tempo. Every surveyed commercial free tier
(Alchemy, Infura, QuickNode, Ankr, dRPC) excludes the debug and trace APIs;
they are a paid-plan feature.

A Trace registration on a chain that is not known to answer the method is
**refused at map time** with one warn line naming the chain, rather than
accepted and then quietly abandoned on the first refusal. The default allowed
set is derived from that survey and lives in
`event-tracker/src/chains/trace-capability.ts`.

The survey measured the tree-configured public defaults, and it records that
nobody has confirmed what the production `CHAIN_RPC_CONFIG` resolves to. If
this deployment's upstreams are keyed and on a plan that includes the debug
namespace, state the chains:

| Variable | Meaning |
| --- | --- |
| `TRACE_CAPABLE_CHAIN_IDS` unset or empty | the surveyed default set applies |
| `TRACE_CAPABLE_CHAIN_IDS=1,8453,42161` | replaces the default set with exactly these chain IDs |
| `TRACE_CAPABLE_CHAIN_IDS=*` | trusts every chain to answer the method |
| `TRACE_CAPABLE_CHAIN_IDS=none` | trusts no chain; refuses every Trace registration |

It replaces rather than extends, so a chain in the default set that this
deployment's upstream does not serve can be removed.

Two parsing rules are worth stating, because the obvious guesses are wrong:

- An entry that is not a positive integer is dropped with a warn naming it, and
  the rest of the list still applies, so one typo does not widen the set to `*`
  or narrow it to nothing. `0` is one of those entries: EIP-155 chain IDs start
  at 1.
- A value that names **no** usable chain at all -- every entry a typo -- falls
  back to the surveyed default set and says so in a warn. It is not read as
  "none": the operator set the variable in order to enable chains, and reading a
  typo as the opposite instruction would turn off every Trace trigger in the
  deployment. `none` is the only way to say none.

In-cluster this is a chart value, not a runtime knob. It is declared empty in
`deploy/event-tracker/staging/values.yaml` and
`deploy/event-tracker/prod/values.yaml`, so setting it is an edit to the `env:`
map in those files plus a redeploy; there is no way to change it on a running
pod.

### Exercising it locally against Anvil

Anvil serves `debug_traceBlockByNumber`, but `31337` is not in the surveyed set,
because the survey probed the configured public upstreams rather than local
nodes. A Trace registration on a local Anvil is therefore refused by default.
Name the chain to run one:

```bash
cd event-tracker
TRACE_CAPABLE_CHAIN_IDS=31337 pnpm dev
```

Add it to the list rather than using `*` if other chains are also configured,
since the override replaces the default set rather than extending it.

If an upstream that passed this gate refuses the method at runtime, trace
matching is paused on that connection until it reconnects and
`GET /healthz` reports **503 `degraded`** with `traceUnsupported: true` on the
affected chain. That is a monitoring signal only: the deployed liveness and
readiness probes are `pgrep` exec probes, so it does not restart the pod.

### It bills per call frame, not per transaction

Matching is per call frame, and `reverted` propagates from an ancestor frame to
every descendant, because the EVM rolls those descendants back. One reverted
transaction whose call tree enters the watched contract repeatedly therefore
produces one match - and **bills one workflow execution** - per rolled-back
descendant, not one for the transaction.

This is intended: a reverted drain attempt is the signal the trigger exists to
catch, and collapsing a call tree into a single execution would lose which
frame was the attempt. But it means a single failed transaction against a
contract that is called in a loop can bill up to 25 executions for one
subscription (`TRACE_DISPATCH_CAP_PER_BLOCK`, the per-subscription per-block
ceiling). A `status` of `reverted` or `any` is the configuration where this
shows up. Narrow with `selector`, `caller` or `callTypes` to stay below it.

## Project Structure

```
keeperhub-events/
├── docker-compose.yml          # Docker Compose configuration
├── .env.docker                 # Environment variables template
├── event-tracker/           # Event tracker service
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
├── deploy/                     # Deployment configurations
│   ├── local/                  # Local/Minikube deployment
│   ├── event-tracker/       # Kubernetes values
└── workflows/                  # GitHub Actions workflows
```

## License

ISC
