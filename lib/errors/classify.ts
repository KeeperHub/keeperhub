import { ErrorCategory } from "@/lib/logging";

/**
 * Classification of a workflow execution failure into:
 *   - errorCategory: one of the ErrorCategory enum values
 *   - isUserError:   true if the failure was caused by the workflow author's
 *                    configuration (template variables, contract args, code
 *                    typos, missing tokens, etc.) and false if the failure
 *                    was caused by KeeperHub itself (database, infra, plugin
 *                    registry, missing secret, etc.).
 *
 * The classifier is intentionally pattern-driven against real production
 * messages observed for managed clients (Sky/Ajna) so the resulting
 * `is_user_error` label on `workflow_executions` lets the SLA alert filter
 * out user-config noise.
 *
 * Default for unmatched messages is WORKFLOW_ENGINE / isUserError=false.
 * That defaults to "treat unknown as system" so a real engine failure that
 * doesn't match any known pattern still pages, and a new user-config family
 * shows up in dashboards as engine-classified until a pattern is added.
 */
export type ExecutionErrorClassification = {
  errorCategory: ErrorCategory;
  isUserError: boolean;
};

type Rule = {
  pattern: RegExp;
  errorCategory: ErrorCategory;
  isUserError: boolean;
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
    isUserError: true,
  },
  {
    pattern: /Missing template variable/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    isUserError: true,
  },
  {
    pattern: /safe-fetch:\s*invalid URL/i,
    errorCategory: ErrorCategory.VALIDATION,
    isUserError: true,
  },
  {
    pattern: /safe-fetch:\s*scheme .* not allowed/i,
    errorCategory: ErrorCategory.VALIDATION,
    isUserError: true,
  },
  {
    pattern: /blocked by SSRF policy/i,
    errorCategory: ErrorCategory.VALIDATION,
    isUserError: true,
  },
  {
    pattern: /^URL is required/i,
    errorCategory: ErrorCategory.VALIDATION,
    isUserError: true,
  },

  // User-config: code-step authoring mistakes
  {
    pattern: /^Code execution failed/i,
    errorCategory: ErrorCategory.VALIDATION,
    isUserError: true,
  },

  // User-config: contract / web3 inputs the author wired up
  {
    pattern: /^Contract call failed/i,
    errorCategory: ErrorCategory.TRANSACTION,
    isUserError: true,
  },
  {
    pattern: /^Invalid contract address/i,
    errorCategory: ErrorCategory.VALIDATION,
    isUserError: true,
  },
  {
    pattern: /^Invalid (function arguments|ABI JSON|payable value)/i,
    errorCategory: ErrorCategory.VALIDATION,
    isUserError: true,
  },
  {
    pattern: /^For Each:\s*arraySource is required/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    isUserError: true,
  },
  {
    pattern: /^Condition references field/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    isUserError: true,
  },
  {
    pattern: /^Failed to evaluate condition expression/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    isUserError: true,
  },
  {
    pattern: /^No token selected/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    isUserError: true,
  },
  {
    pattern: /^HTTP request failed:\s*Missing template variable/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    isUserError: true,
  },
  {
    pattern: /^HTTP request failed:\s*Request with GET\/HEAD method/i,
    errorCategory: ErrorCategory.VALIDATION,
    isUserError: true,
  },

  // External-service / network: dependencies outside KeeperHub
  {
    pattern: /^Failed to check balance:\s*RPC failed/i,
    errorCategory: ErrorCategory.NETWORK_RPC,
    isUserError: false,
  },
  {
    pattern: /RPC failed on both endpoints/i,
    errorCategory: ErrorCategory.NETWORK_RPC,
    isUserError: false,
  },
  {
    pattern: /^Failed to send webhook:\s*fetch failed:\s*getaddrinfo/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    isUserError: true,
  },
  {
    pattern: /^Failed to send webhook/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    isUserError: false,
  },

  // System: database / persistence layer
  {
    pattern: /^Database query failed/i,
    errorCategory: ErrorCategory.DATABASE,
    isUserError: false,
  },
  {
    pattern: /^Failed query:/i,
    errorCategory: ErrorCategory.DATABASE,
    isUserError: false,
  },
  {
    pattern: /^getaddrinfo .*\.rds\.amazonaws\.com/i,
    errorCategory: ErrorCategory.DATABASE,
    isUserError: false,
  },

  // System: workflow engine / executor
  {
    pattern: /^Execution timed out/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    isUserError: false,
  },
  {
    pattern: /^Workflow terminated by SIGTERM/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    isUserError: false,
  },
  {
    pattern: /^Step ".*" exceeded max retries/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    isUserError: false,
  },
  {
    pattern: /^Unknown action type:/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    isUserError: false,
  },
  {
    pattern: /^Failed to acquire nonce lock/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    isUserError: false,
  },

  // System: deploy bugs / missing modules / missing secrets
  {
    pattern: /^Cannot find module/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    isUserError: false,
  },
  {
    pattern: /must be set\s*$/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    isUserError: false,
  },
  {
    pattern: /^Failed to initialize organization wallet/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    isUserError: false,
  },
];

/**
 * Classify a workflow execution error message into an `ErrorCategory` and a
 * user-vs-system flag.
 *
 * Returns `WORKFLOW_ENGINE` / `isUserError=false` for null, empty, or
 * unmatched messages so unknown failures still surface to system-level
 * alerting until a more specific rule is added.
 */
export function classifyExecutionError(
  errorMessage: string | null | undefined
): ExecutionErrorClassification {
  if (!errorMessage) {
    return {
      errorCategory: ErrorCategory.WORKFLOW_ENGINE,
      isUserError: false,
    };
  }

  const trimmed = errorMessage.trim();
  if (trimmed.length === 0) {
    return {
      errorCategory: ErrorCategory.WORKFLOW_ENGINE,
      isUserError: false,
    };
  }

  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
        errorCategory: rule.errorCategory,
        isUserError: rule.isUserError,
      };
    }
  }

  return {
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    isUserError: false,
  };
}
