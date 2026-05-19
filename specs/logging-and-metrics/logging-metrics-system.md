# Unified Logging + Metrics System Specification

## Overview

The unified logging system ensures 100% metric coverage for all errors and warnings by providing two core functions that automatically log to console AND emit Prometheus metrics.

## API

### Core Functions

```typescript
import { ErrorCategory, logUserError, logSystemError } from "@/keeperhub/lib/logging";
```

#### logUserError
```typescript
logUserError(category: ErrorCategory, message: string, error?: unknown, labels?: Record<string, string>): void
```

Use for errors caused by user actions or external factors (not system failures).

**Categories:**
- `ErrorCategory.VALIDATION` - Invalid inputs, addresses, schema violations
- `ErrorCategory.CONFIGURATION` - Missing API keys, invalid settings (user-provided config)
- `ErrorCategory.EXTERNAL_SERVICE` - Etherscan, Discord, SendGrid API failures
- `ErrorCategory.NETWORK_RPC` - RPC connection failures, timeouts, chain unavailable
- `ErrorCategory.TRANSACTION` - Transaction failures, gas estimation errors, nonce issues

**Behavior:**
- Logs to console using `console.warn` (user errors don't wake up DevOps)
- Emits Prometheus metric with `error_type: "user"`
- Extracts context from message prefix (e.g., `"[Discord]"` becomes `"Discord"`)

#### logSystemError
```typescript
logSystemError(category: ErrorCategory, message: string, error: unknown, labels?: Record<string, string>): void
```

Use for errors caused by system failures (critical infrastructure issues).

**Categories:**
- `ErrorCategory.DATABASE` - Query failures, connection errors, constraint violations
- `ErrorCategory.AUTH` - Session failures, token validation errors, permission denied
- `ErrorCategory.INFRASTRUCTURE` - Missing environment variables, deployment failures (system config)
- `ErrorCategory.WORKFLOW_ENGINE` - Workflow execution failures, step resolution errors

**Behavior:**
- Logs to console using `console.error` (critical failures)
- Emits Prometheus metric with `error_type: "system"`
- Extracts context from message prefix

## Usage Examples

### Validation Error
```typescript
if (!ethers.isAddress(address)) {
  logUserError(
    ErrorCategory.VALIDATION,
    "[Check Balance] Invalid address",
    address,
    { plugin_name: "web3" }
  );
  return { success: false, error: "Invalid address" };
}
```

### External Service Error
```typescript
try {
  const response = await fetch(etherscanUrl);
  if (!response.ok) {
    logUserError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[Etherscan] API request failed",
      new Error(`HTTP ${response.status}`),
      { service: "etherscan" }
    );
  }
} catch (error) {
  logUserError(
    ErrorCategory.EXTERNAL_SERVICE,
    "[Etherscan] Network error",
    error,
    { service: "etherscan" }
  );
}
```

### Database Error
```typescript
try {
  await db.insert(workflows).values(data);
} catch (error) {
  logSystemError(
    ErrorCategory.DATABASE,
    "[DB] Failed to insert workflow",
    error,
    { table: "workflows" }
  );
  throw error;
}
```

### Infrastructure Error
```typescript
if (!process.env.PARA_API_KEY) {
  logSystemError(
    ErrorCategory.INFRASTRUCTURE,
    "[Para] PARA_API_KEY not configured",
    new Error("PARA_API_KEY environment variable is not configured"),
    { component: "para-service" }
  );
  throw new Error("PARA_API_KEY not configured");
}
```

## Best Practices

### DO
- Pass error objects directly when available: `error`
- Use simple Error messages: `new Error("Failed to send email")`
- Keep labels minimal: `{ service: "sendgrid" }`
- Follow message format: `"[Context] Description"`
- Choose the correct category (validation vs configuration, user vs system)

### DON'T
- Add explicit `console.error` or `console.warn` before logging calls (redundant - functions handle this)
- Create complex Error messages: `new Error(`${status}: ${text}`)` (put details in labels instead)
- Add redundant labels that duplicate message content
- Use generic messages like "Error occurred" (be specific)

## Message Format

All messages should follow the pattern: `"[Context] Description"`

**Examples:**
- `"[Discord] Failed to send message"`
- `"[Etherscan] API rate limit exceeded"`
- `"[DB] Connection timeout"`
- `"[Para] PARA_API_KEY not configured"`

The context (part in brackets) is automatically extracted and added as the `error_context` label.

## Label Conventions

### Common Labels
- `service` - External service name (e.g., "etherscan", "sendgrid")
- `endpoint` - API endpoint path (e.g., "/api/workflows")
- `component` - System component (e.g., "para-service", "events-service")
- `chain_id` - Blockchain chain ID (as string)
- `plugin_name` - Plugin identifier (e.g., "web3", "discord")
- `action_name` - Plugin action (e.g., "send-message", "check-balance")

### Label Rules
- Use lowercase with underscores: `chain_id` not `chainId`
- Keep labels minimal (3-5 max)
- Convert numbers to strings: `chain_id: chainId.toString()`
- Don't duplicate message content in labels

## Automatic Labels

Every logging call automatically includes these labels:

- `error_category` - The ErrorCategory value (e.g., "validation", "database")
- `error_context` - Extracted from message prefix (e.g., "Discord", "Etherscan")
- `error_type` - "user" for logUserError, "system" for logSystemError

## Prometheus Metrics

### Metric Names

**User Errors:**
- `errors.user.validation.total` - Validation failures
- `errors.user.configuration.total` - Configuration issues (user-provided)
- `errors.external.service.total` - External API failures
- `errors.network.rpc.total` - RPC/network errors
- `errors.transaction.blockchain.total` - Transaction failures

**System Errors:**
- `errors.system.database.total` - Database errors
- `errors.system.auth.total` - Authentication/authorization failures
- `errors.system.infrastructure.total` - Infrastructure issues (system config)
- `errors.system.workflow_engine.total` - Workflow engine failures

### Example Prometheus Queries

```promql
# User errors by category (last 5 minutes)
sum by (error_category) (
  rate(errors_user_validation_total[5m])
  + rate(errors_external_service_total[5m])
  + rate(errors_network_rpc_total[5m])
)

# System errors by category
sum by (error_category) (
  rate(errors_system_database_total[5m])
  + rate(errors_system_infrastructure_total[5m])
)

# Errors by context (Discord, Etherscan, etc.)
topk(10, sum by (error_context) (
  rate(errors_user_validation_total[5m])
))

# External service error rate
sum(rate(errors_external_service_total[5m])) by (service)
```

## Decision Tree: Which Category?

```
Is this error caused by the system itself?
├─ YES → Use logSystemError
│  ├─ Database query failed → ErrorCategory.DATABASE
│  ├─ Auth session invalid → ErrorCategory.AUTH
│  ├─ Missing env var (system) → ErrorCategory.INFRASTRUCTURE
│  └─ Workflow engine error → ErrorCategory.WORKFLOW_ENGINE
│
└─ NO → Use logUserError
   ├─ Invalid user input → ErrorCategory.VALIDATION
   ├─ Missing API key (user config) → ErrorCategory.CONFIGURATION
   ├─ External API failed → ErrorCategory.EXTERNAL_SERVICE
   ├─ RPC connection failed → ErrorCategory.NETWORK_RPC
   └─ Transaction failed → ErrorCategory.TRANSACTION
```

## Configuration vs Infrastructure

**Configuration (User Error):**
- User-provided API keys in integration settings
- User-configured webhook URLs
- User-selected chain settings
→ Use `ErrorCategory.CONFIGURATION`

**Infrastructure (System Error):**
- Required environment variables (PARA_API_KEY, SENDGRID_API_KEY)
- System deployment configuration
- Missing required system services
→ Use `ErrorCategory.INFRASTRUCTURE`

## Migration Guide

### Before (Old API)
```typescript
// Old convenience functions (removed)
logValidationError(message, error, labels);
logNetworkError(message, error, labels);
logExternalServiceError(message, error, labels);
logDatabaseError(message, error, labels);
// ... etc
```

### After (New API)
```typescript
// New unified API with explicit categories
logUserError(ErrorCategory.VALIDATION, message, error, labels);
logUserError(ErrorCategory.NETWORK_RPC, message, error, labels);
logUserError(ErrorCategory.EXTERNAL_SERVICE, message, error, labels);
logSystemError(ErrorCategory.DATABASE, message, error, labels);
```

## Implementation Details

**File:** `/keeperhub/lib/logging.ts`

**Dependencies:**
- `@/keeperhub/lib/metrics` - Metrics collector interface
- `getMetricsCollector()` - Returns the active metrics collector
- `MetricNames` - Enum of all metric names
- `LabelKeys` - Enum of standard label keys

**Internal Functions:**
- `extractContext(message)` - Extracts `[Context]` from message prefix using regex
- `getMetricName(category)` - Maps ErrorCategory to Prometheus metric name
- `errorTypeForCategory(category)` - Determines whether category is "user" or "system"

## Testing

### Unit Tests
**File:** `/tests/unit/logging.test.ts`

Tests verify:
- Correct console method called (warn vs error)
- Correct metric emitted
- Context extraction from message prefix
- Label propagation
- Error category mapping

### Integration Testing
```typescript
// Trigger an error
logUserError(ErrorCategory.VALIDATION, "[Test] Invalid input", "details");

// Check logs
// [WARN] [Test] Invalid input details

// Check metrics endpoint
// GET /api/metrics
// errors_user_validation_total{error_category="validation",error_context="Test"} 1
```

## Alerts

### Recommended Grafana Alerts

**High User Error Rate:**
```promql
sum(rate(errors_user_validation_total[5m])) > 10
```

**System Error Detected:**
```promql
sum(rate(errors_system_infrastructure_total[5m])) > 0
```

**External Service Degradation:**
```promql
sum(rate(errors_external_service_total[5m])) by (service) > 5
```

## Benefits

1. **Complete Observability** - Every error automatically tracked in Prometheus
2. **Better Alerting** - Alert on metric rates, not log text matching
3. **Error Attribution** - Clear separation of user errors vs system failures
4. **Consistent Patterns** - One way to log errors across the codebase
5. **Type Safety** - Enum-based categories prevent typos
6. **Automatic Labeling** - Standard labels added automatically
7. **Context Extraction** - Message prefix becomes searchable label

## Related Documentation

- `/keeperhub/lib/metrics/types.ts` - Metric names and label keys
- `/keeperhub/lib/metrics/README.md` - Metrics system overview
- `/tests/unit/logging.test.ts` - Test examples
