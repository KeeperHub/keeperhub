# Workflow Runtime Analysis Framework

A unified profiling framework for understanding and optimizing KeeperHub workflow execution costs.

## Overview

This framework provides four complementary profiling approaches:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      WORKFLOW PROFILING FRAMEWORK                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   STATIC    │    │    STEP     │    │  WORKFLOW   │    │    WASM     │  │
│  │  ANALYSIS   │    │  PROFILING  │    │  PROFILING  │    │ CALIBRATION │  │
│  │             │    │             │    │             │    │             │  │
│  │ AST-based   │    │ V8 CPU      │    │ Full exec   │    │ Fuel        │  │
│  │ complexity  │    │ profiling   │    │ profiling   │    │ metering    │  │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘  │
│         │                  │                  │                  │         │
│         ▼                  ▼                  ▼                  ▼         │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     COST MODEL / PRICING                            │   │
│  │                                                                     │   │
│  │   Static complexity → Runtime function calls → WASM fuel → Price   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Start profiling infrastructure
docker compose --profile profile-workflows up -d

# Run all analysis
pnpm profile:analyze                    # Static analysis
pnpm profile:step --all --dry-run       # Step comparison
pnpm profile:calibrate                  # WASM fuel baselines
```

## The Four Tools

### 1. Static Analysis (`profile:analyze`)

**What it measures:** Code structure without execution
- Cyclomatic complexity
- Await expressions (async operations)
- External calls (fetch, SDK, DB)
- Try-catch blocks

**When to use:**
- Before writing new steps (set complexity budget)
- Code review (identify high-complexity code)
- Refactoring decisions

**Key finding:** Static complexity does NOT predict runtime cost.

```bash
pnpm profile:analyze --json > analysis.json
```

### 2. Step Profiling (`profile:step`)

**What it measures:** V8 CPU profiling per step
- Function call counts (precise mode)
- Sample distribution (sampling mode)
- Memory delta
- Module load time

**When to use:**
- Compare steps head-to-head
- Identify heavy dependencies
- Measure cold start overhead

**Key finding:** Dependencies dominate cost (ethers.js = 215K calls vs webhook = 5K calls).

```bash
# Sampling mode (fast, statistical)
pnpm profile:step --step web3/check-balance

# Precise mode (exact counts, slower)
pnpm profile:step --step web3/check-balance --precise

# Compare all steps
pnpm profile:step --all --dry-run --precise
```

### 3. Workflow Profiling (`profile:workflow`)

**What it measures:** Full workflow execution
- End-to-end execution time
- Function calls by category (DB, step, executor)
- Step-level timing
- Real I/O costs

**When to use:**
- Production workflow analysis
- Database optimization
- Integration testing

**Key finding:** Database operations account for 50%+ of function calls.

```bash
WORKFLOW_ID=xxx EXECUTION_ID=yyy pnpm profile:workflow
```

### 4. WASM Fuel Calibration (`profile:calibrate`)

**What it measures:** Deterministic instruction counts
- Fuel per operation type
- Baseline overhead
- Operation cost hierarchy

**When to use:**
- Set execution limits for user code
- Build pricing models
- Sandbox configuration

**Key finding:** Operations vary 50x (addition: 856 fuel vs workflow-sim: 44,845 fuel).

```bash
docker compose --profile profile-workflows up -d
pnpm profile:calibrate
```

## Unified Cost Model

### Step Tiers (Based on Function Calls)

| Tier | Steps | Function Calls | Relative Cost |
|------|-------|----------------|---------------|
| Light | webhook, resend, sendgrid | ~5K | 1x |
| Medium | slack, discord | ~150K | 30x |
| Heavy | web3/* | ~215K | 40x |

### Pricing Formula

```
step_cost = base_compute_units + (io_multiplier × io_operations)
```

| Step Type | Base Units | I/O Multiplier | Total |
|-----------|------------|----------------|-------|
| trigger | 1 | 0 | 1 |
| webhook | 1 | 1× | 2 |
| email | 1 | 1× | 2 |
| slack | 3 | 2× | 5 |
| web3 (read) | 5 | 3× | 8 |
| web3 (write) | 5 | 10× | 15 |

### WASM Fuel Budgets

| Target Operations | Fuel Budget |
|-------------------|-------------|
| 1,000 ops | 6.4M fuel |
| 10,000 ops | 64M fuel |
| 100,000 ops | 640M fuel |

## Optimization Priorities

### High Impact (30-50% reduction)

1. **Database queries** - Batch operations, add caching
2. **Query optimization** - Reduce Drizzle ORM overhead
3. **Connection pooling** - Reuse Postgres connections

### Medium Impact (15-25% reduction)

1. **Lazy-load web3** - Don't load ethers.js until needed
2. **Lighter web3 libs** - Use viem for simple operations
3. **Module splitting** - Reduce cold start time

### Low Impact (<5% reduction)

1. **Step code refactoring** - Actual step logic is <1% of cost
2. **Complexity reduction** - Static metrics don't correlate with runtime

## Infrastructure

### Docker Compose Profile

```bash
# Start profiling infrastructure
docker compose --profile profile-workflows up -d

# Services started:
# - keeperhub-db (port 5433) - PostgreSQL
# - keeperhub-js-sandbox (port 3001) - WASM fuel metering

# Stop when done
docker compose --profile profile-workflows down
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection | From .env |
| `WORKFLOW_ID` | Workflow to profile | Required for workflow |
| `EXECUTION_ID` | Execution to profile | Required for workflow |
| `SANDBOX_URL` | JS sandbox URL | http://localhost:3001 |
| `PRECISE_COVERAGE` | Use exact counts | false |
| `PROFILE_DETAIL` | Show detailed output | false |

## File Structure

```
scripts/workflow_runtime_analysis/
├── README.md                           # This file
├── analyze-steps.ts                    # Static AST analysis
├── profile-step.ts                     # V8 step profiling
├── workflow-runner-profiled.ts         # Workflow execution profiling
├── workflow-runner-profiled-bootstrap.ts   # Bootstrap (patches server-only)
└── calibrate-wasm-fuel.ts              # WASM fuel calibration
```

## Integration with CI/CD

### Pre-commit: Static Analysis

```yaml
- name: Static complexity check
  run: |
    pnpm profile:analyze --json > /tmp/analysis.json
    MAX_COMPLEXITY=$(jq '.summary.avgCyclomaticComplexity' /tmp/analysis.json)
    if [ "$MAX_COMPLEXITY" -gt 15 ]; then
      echo "Average complexity too high: $MAX_COMPLEXITY"
      exit 1
    fi
```

### PR Check: Step Comparison

```yaml
- name: Profile new steps
  run: |
    pnpm profile:step --all --dry-run --json > /tmp/profile.json
    # Compare against baseline
```

## Related Documentation

- [KEEP-1229 Findings](../../../docs/keeperhub/KEEP-1229/workflow-profiling-analysis.md)
- [Workflow SDK Observability](https://useworkflow.dev/docs/observability)

## Key Insights

1. **Static ≠ Runtime**: High cyclomatic complexity doesn't mean high runtime cost
2. **Dependencies dominate**: Step code is <1% of total function calls
3. **Database is expensive**: 50%+ of workflow execution is DB operations
4. **I/O variance is high**: Web3 steps vary 10x based on network conditions
5. **WASM is deterministic**: Use fuel metering for predictable limits
