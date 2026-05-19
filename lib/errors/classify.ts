import { ErrorCategory } from "@/lib/logging";

/**
 * Classification of a workflow execution failure into:
 *   - errorCategory: one of the ErrorCategory enum values
 *   - errorType:     "user" if the failure was caused by the workflow author's
 *                    configuration (template variables, contract args, code
 *                    typos, missing tokens, etc.) and "system" if the failure
 *                    was caused by KeeperHub itself (database, infra, plugin
 *                    registry, missing secret, etc.).
 *
 * The classifier is intentionally pattern-driven against real production
 * messages observed for managed clients (Sky/Ajna) so the resulting
 * `error_type` label on `workflow_executions` lets the SLI alert filter
 * out user-config noise.
 *
 * Default for unmatched messages is WORKFLOW_ENGINE / errorType="system".
 * That defaults to "treat unknown as system" so a real engine failure that
 * doesn't match any known pattern still pages, and a new user-config family
 * shows up in dashboards as engine-classified until a pattern is added.
 */
export type ExecutionErrorClassification = {
  errorCategory: ErrorCategory;
  errorType: "user" | "system";
};

type Rule = {
  pattern: RegExp;
  errorCategory: ErrorCategory;
  errorType: "user" | "system";
};

/**
 * Ordered list of rules. First match wins. Order matters when patterns
 * overlap; more specific patterns should come before broader ones.
 */
const RULES: readonly Rule[] = [
  // User-config: template / variable / safe-fetch input failures
  {
    pattern: /^Unresolved template reference/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
  },
  {
    pattern: /Missing template variable/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
  },
  {
    pattern: /safe-fetch:\s*invalid URL/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
  },
  {
    pattern: /safe-fetch:\s*scheme .* not allowed/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
  },
  {
    pattern: /blocked by SSRF policy/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
  },
  {
    pattern: /^URL is required/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
  },

  // User-config: code-step authoring mistakes
  {
    pattern: /^Code execution failed/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
  },

  // User-config: contract / web3 inputs the author wired up
  {
    pattern: /^Contract call failed/i,
    errorCategory: ErrorCategory.TRANSACTION,
    errorType: "user",
  },
  {
    pattern: /^Invalid contract address/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
  },
  {
    pattern: /^Invalid (function arguments|ABI JSON|payable value)/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
  },
  {
    pattern: /^For Each:\s*arraySource is required/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
  },
  {
    pattern: /^Condition references field/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
  },
  {
    pattern: /^Failed to evaluate condition expression/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
  },
  {
    pattern: /^No token selected/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
  },
  {
    pattern: /^HTTP request failed:\s*Missing template variable/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
  },
  {
    pattern: /^HTTP request failed:\s*Request with GET\/HEAD method/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
  },

  // External-service / network: dependencies outside KeeperHub
  {
    pattern: /^Failed to check balance:\s*RPC failed/i,
    errorCategory: ErrorCategory.NETWORK_RPC,
    errorType: "system",
  },
  {
    pattern: /RPC failed on both endpoints/i,
    errorCategory: ErrorCategory.NETWORK_RPC,
    errorType: "system",
  },
  {
    pattern: /^Failed to send webhook:\s*fetch failed:\s*getaddrinfo/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: "user",
  },
  {
    pattern: /^Failed to send webhook/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: "system",
  },

  // System: database / persistence layer
  {
    pattern: /^Database query failed/i,
    errorCategory: ErrorCategory.DATABASE,
    errorType: "system",
  },
  {
    pattern: /^Failed query:/i,
    errorCategory: ErrorCategory.DATABASE,
    errorType: "system",
  },
  {
    pattern: /^getaddrinfo .*\.rds\.amazonaws\.com/i,
    errorCategory: ErrorCategory.DATABASE,
    errorType: "system",
  },

  // System: workflow engine / executor
  {
    pattern: /^Execution timed out/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: "system",
  },
  {
    pattern: /^Workflow terminated by SIGTERM/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    errorType: "system",
  },
  {
    pattern: /^Step ".*" exceeded max retries/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: "system",
  },
  {
    pattern: /^Unknown action type:/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: "system",
  },
  {
    pattern: /^Failed to acquire nonce lock/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: "system",
  },

  // System: deploy bugs / missing modules / missing secrets
  {
    pattern: /^Cannot find module/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    errorType: "system",
  },
  {
    pattern: /must be set\s*$/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    errorType: "system",
  },
  {
    pattern: /^Failed to initialize organization wallet/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    errorType: "system",
  },
];

/**
 * Classify a workflow execution error message into an `ErrorCategory` and a
 * user-vs-system flag.
 *
 * Returns `WORKFLOW_ENGINE` / `errorType="system"` for null, empty, or
 * unmatched messages so unknown failures still surface to system-level
 * alerting until a more specific rule is added.
 */
export function classifyExecutionError(
  errorMessage: string | null | undefined
): ExecutionErrorClassification {
  if (!errorMessage) {
    return {
      errorCategory: ErrorCategory.WORKFLOW_ENGINE,
      errorType: "system",
    };
  }

  const trimmed = errorMessage.trim();
  if (trimmed.length === 0) {
    return {
      errorCategory: ErrorCategory.WORKFLOW_ENGINE,
      errorType: "system",
    };
  }

  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
        errorCategory: rule.errorCategory,
        errorType: rule.errorType,
      };
    }
  }

  return {
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: "system",
  };
}
