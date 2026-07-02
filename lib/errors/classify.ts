import {
  DEFAULT_SYSTEM_ERROR_CODE,
  type ErrorCode,
} from "@/lib/errors/error-codes";
import { ErrorCategory } from "@/lib/logging";

/**
 * Classification of a workflow execution failure into:
 *   - errorCategory: one of the ErrorCategory enum values
 *   - errorType:     "user" if the failure was caused by the workflow author's
 *                    configuration (template variables, contract args, code
 *                    typos, missing tokens, etc.) and "system" if the failure
 *                    was caused by KeeperHub itself (database, infra, plugin
 *                    registry, missing secret, etc.).
 *   - code:          a `PREFIX-NNNN` system error code for system failures, or
 *                    null for user failures (which surface their raw message).
 *
 * The classifier is intentionally pattern-driven against real production
 * messages observed for managed clients so the resulting `error_type` label on
 * `workflow_executions` lets the SLI alert filter out user-config noise.
 *
 * Default for unmatched messages is WORKFLOW_ENGINE / errorType="system" /
 * code=DEFAULT_SYSTEM_ERROR_CODE. That defaults to "treat unknown as system"
 * so a real engine failure that doesn't match any known pattern still pages,
 * and a new user-config family shows up in dashboards as engine-classified
 * until a pattern is added.
 */
export type ExecutionErrorClassification = {
  errorCategory: ErrorCategory;
  errorType: "user" | "system";
  code: ErrorCode | null;
};

type Rule = {
  pattern: RegExp;
  errorCategory: ErrorCategory;
  errorType: "user" | "system";
  /** null for user rules (raw message is shown); a code for system rules. */
  code: ErrorCode | null;
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
    code: null,
  },
  {
    pattern: /Missing template variable/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /safe-fetch:\s*invalid URL/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /safe-fetch:\s*scheme .* not allowed/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /blocked by SSRF policy/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /^URL is required/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
    code: null,
  },

  // User-config: code-step authoring mistakes
  {
    pattern: /^Code execution failed/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
    code: null,
  },

  // User-config: contract / web3 inputs the author wired up
  {
    pattern: /^Contract call failed/i,
    errorCategory: ErrorCategory.TRANSACTION,
    errorType: "user",
    code: null,
  },
  {
    pattern:
      /^(Token approval failed|Token transfer failed|Transaction failed):/i,
    errorCategory: ErrorCategory.TRANSACTION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /^Invalid contract address/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /^Invalid Ethereum address/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /^Invalid (function arguments|ABI JSON|payable value)/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /Function '.+' not found in ABI/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /^For Each:\s*arraySource is required/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /^Condition references field/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /^Failed to evaluate condition expression/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /^No token selected/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /^HTTP request failed:\s*Missing template variable/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
    code: null,
  },
  {
    pattern: /^HTTP request failed:\s*Request with GET\/HEAD method/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: "user",
    code: null,
  },
  // User-config: database integration not configured
  {
    pattern: /^DATABASE_URL is not configured/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
    code: null,
  },
  // User-config: integration credential not configured
  {
    pattern: /API key is required/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
    code: null,
  },
  // User-action: Para wallet session needs re-export
  // Must come BEFORE the generic `^Failed to initialize organization wallet` rule below.
  {
    pattern:
      /^Failed to initialize organization wallet:\s*Para session expired/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: "user",
    code: null,
  },

  // External-service / network: dependencies outside KeeperHub
  {
    pattern: /^Failed to check balance:\s*RPC failed/i,
    errorCategory: ErrorCategory.NETWORK_RPC,
    errorType: "system",
    code: "N-0001",
  },
  {
    pattern: /RPC failed on both endpoints/i,
    errorCategory: ErrorCategory.NETWORK_RPC,
    errorType: "system",
    code: "N-0001",
  },
  {
    pattern: /^Failed to send webhook:\s*fetch failed:\s*getaddrinfo/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: "user",
    code: null,
  },
  {
    pattern: /^Failed to send webhook/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: "system",
    code: "N-0002",
  },
  // User-config: external endpoint returned non-2xx (webhook/safe/discord/etc.)
  {
    pattern: /^HTTP \d{3}:/,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: "user",
    code: null,
  },
  // User-config: HTTP request step couldn't reach the external endpoint
  // (DNS, ECONNRESET, connection timeout, TLS) or got a non-2xx response.
  // Falls below the more specific `Missing template variable` /
  // `GET/HEAD method` rules above.
  {
    pattern: /^HTTP request failed(:\s|\s+with status\s+\d+)/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: "user",
    code: null,
  },

  // System: database / persistence layer
  {
    pattern: /^Database query failed/i,
    errorCategory: ErrorCategory.DATABASE,
    errorType: "system",
    code: "C-0002",
  },
  {
    pattern: /^Failed query:/i,
    errorCategory: ErrorCategory.DATABASE,
    errorType: "system",
    code: "C-0002",
  },
  {
    pattern: /^getaddrinfo .*\.rds\.amazonaws\.com/i,
    errorCategory: ErrorCategory.DATABASE,
    errorType: "system",
    code: "C-0002",
  },

  // System: workflow engine / executor
  {
    pattern: /^Execution timed out/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: "system",
    code: "E-0001",
  },
  {
    pattern: /^Workflow terminated by SIGTERM/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    errorType: "system",
    code: "P-0003",
  },
  {
    pattern: /^Step ".*" exceeded max retries/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: "system",
    code: "E-0002",
  },
  {
    pattern: /^Unknown action type:/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: "system",
    code: "E-0003",
  },
  {
    pattern: /^Failed to acquire nonce lock/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: "system",
    code: "E-0003",
  },

  // System: deploy bugs / missing modules / missing secrets
  {
    pattern: /^Cannot find module/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    errorType: "system",
    code: "C-0003",
  },
  {
    pattern: /must be set\s*$/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    errorType: "system",
    code: "C-0003",
  },
  {
    pattern: /^Failed to initialize organization wallet/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    errorType: "system",
    code: "C-0003",
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
      code: DEFAULT_SYSTEM_ERROR_CODE,
    };
  }

  const trimmed = errorMessage.trim();
  if (trimmed.length === 0) {
    return {
      errorCategory: ErrorCategory.WORKFLOW_ENGINE,
      errorType: "system",
      code: DEFAULT_SYSTEM_ERROR_CODE,
    };
  }

  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
        errorCategory: rule.errorCategory,
        errorType: rule.errorType,
        code: rule.code,
      };
    }
  }

  return {
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: "system",
    code: DEFAULT_SYSTEM_ERROR_CODE,
  };
}

/**
 * True when a classification is the catch-all default produced for a null,
 * empty, or unmatched message (errorType "system", DEFAULT_SYSTEM_ERROR_CODE).
 * Unmatched failures are deliberately treated as system for ALERTING, but they
 * are not confidently a platform fault, so callers use this to keep the
 * user-facing status a plain `error` rather than mislabeling it `system_error`.
 */
export function isDefaultClassification(
  classification: ExecutionErrorClassification
): boolean {
  return classification.code === DEFAULT_SYSTEM_ERROR_CODE;
}
