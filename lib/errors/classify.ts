import {
  DEFAULT_SYSTEM_ERROR_CODE,
  type ErrorCode,
} from "@/lib/errors/error-codes";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory } from "@/lib/logging";

export { ExecutionErrorType } from "@/lib/errors/execution-error-type";

/**
 * Classification of a workflow execution failure into:
 *   - errorCategory: one of the ErrorCategory enum values
 *   - errorType:     "user" if the failure was caused by the workflow author's
 *                    configuration (template variables, contract args, code
 *                    typos, missing tokens, etc.); "system" if the failure was
 *                    caused by KeeperHub itself (database, infra, plugin
 *                    registry, missing secret, etc.); and "external" if the
 *                    failure originated in a third-party endpoint the customer
 *                    configured the workflow to call (HTTP request / webhook
 *                    transport failures such as timeouts, connection resets, DNS
 *                    failures) where neither the customer's config nor KeeperHub
 *                    is at fault. RPC endpoints are KeeperHub-managed, so an
 *                    `RPC failed ...` message stays "system" here; the one
 *                    exception is the private-mempool relay a node opted into,
 *                    which we point at but do not operate. The RPC layer tags
 *                    that at the failure site and the step forwards it as an
 *                    errorClass hint.
 *   - code:          a `PREFIX-NNNN` system error code for system failures, or
 *                    null for user and external failures (which surface their
 *                    raw message).
 *
 * The classifier is intentionally pattern-driven against real production
 * messages observed for managed clients (Sky/Ajna) so the resulting
 * `error_type` label on `workflow_executions` lets the SLI alert filter
 * out user-config noise.
 *
 * Default for unmatched messages is WORKFLOW_ENGINE / errorType="system" /
 * code=DEFAULT_SYSTEM_ERROR_CODE. That defaults to "treat unknown as system"
 * so a real engine failure that doesn't match any known pattern still pages,
 * and a new user-config family shows up in dashboards as engine-classified
 * until a pattern is added.
 */
export type ExecutionErrorClassification = {
  errorCategory: ErrorCategory;
  errorType: ExecutionErrorType;
  code: ErrorCode | null;
};

type Rule = {
  pattern: RegExp;
  errorCategory: ErrorCategory;
  errorType: ExecutionErrorType;
  /**
   * A code for system rules; null for user and external rules (their raw
   * message is shown to the customer).
   */
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
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /Missing template variable/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // An action node the author never assigned an action type to.
  {
    pattern: /has no action type configured/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /safe-fetch:\s*invalid URL/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /safe-fetch:\s*scheme .* not allowed/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /blocked by SSRF policy/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // Unanchored so the `HTTP request failed: URL is required` step-wrapped form
  // stays a user config fault rather than falling into the HTTP transport rule.
  {
    pattern: /URL is required/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },

  // User-config: code-step authoring mistakes
  {
    pattern: /^Code execution failed/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },

  // User-config: contract / web3 inputs the author wired up
  {
    pattern: /^Contract call failed/i,
    errorCategory: ErrorCategory.TRANSACTION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern:
      /^(Token approval failed|Token transfer failed|Transaction failed):/i,
    errorCategory: ErrorCategory.TRANSACTION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // KEEP-966: the execution finalize gate positively confirmed a claimed
  // transaction reverted on-chain (or, for Safe-routed writes, the outer tx
  // succeeded but the wrapped inner call failed per Safe's ExecutionFailure
  // event) -- a real transaction outcome, same bucket as the other
  // Contract/Token/Transaction failed rules above. Must come BEFORE the
  // not_found/timeout rule below: a message can in principle report a mix of
  // failure kinds across multiple hashes, and a confirmed revert is the more
  // actionable, user-facing signal to surface first.
  {
    pattern:
      /^On-chain verification failed.*\((reverted on-chain|Safe inner call failed)/i,
    errorCategory: ErrorCategory.TRANSACTION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // The step reported a revert directly rather than through the finalize
  // gate's `On-chain verification failed` wrapper. Same outcome, same bucket.
  {
    pattern: /^Transaction reverted:/i,
    errorCategory: ErrorCategory.TRANSACTION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // The author's wallet does not hold enough of the asset (or native gas
  // token) for the transfer the workflow asked for. Observed shapes are
  // `Insufficient USDC balance. Have: N, Need: N` and the Solana lamports
  // variant. Anchored so an RPC-exhaustion message that quotes a provider
  // body containing this phrase still falls through to the system RPC rules.
  {
    pattern: /^Insufficient \S+ balance\b/i,
    errorCategory: ErrorCategory.TRANSACTION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // Solana: the destination wallet has no associated token account for the
  // mint the author configured, so the transfer cannot be routed.
  {
    pattern: /^Wallet has no token account for mint/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /^Invalid contract address/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /^Invalid Ethereum address/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /^Invalid (function arguments|ABI JSON|payable value)/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /Function '.+' not found in ABI/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /^For Each:\s*arraySource is required/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /^Condition references field/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /^Failed to evaluate condition expression/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /^Condition node has no expression configured/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /^Condition expression is invalid/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /^No token selected/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /^HTTP request failed:\s*Missing template variable/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /^HTTP request failed:\s*Request with GET\/HEAD method/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // User-config: database integration not configured
  {
    pattern: /^DATABASE_URL is not configured/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // User-config: integration credential not configured
  {
    pattern: /API key is required/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // User-action: Para wallet session needs re-export
  // Must come BEFORE the generic `^Failed to initialize organization wallet` rule below.
  {
    pattern:
      /^Failed to initialize organization wallet:\s*Para session expired/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },

  // System: RPC endpoints are KeeperHub-managed infrastructure, so a failover
  // exhaustion is a platform fault, not a third-party dependency failure.
  {
    pattern: /^Failed to check balance:\s*RPC failed/i,
    errorCategory: ErrorCategory.NETWORK_RPC,
    errorType: ExecutionErrorType.SYSTEM,
    code: "N-0001",
  },
  {
    pattern: /RPC failed on both endpoints/i,
    errorCategory: ErrorCategory.NETWORK_RPC,
    errorType: ExecutionErrorType.SYSTEM,
    code: "N-0001",
  },
  // KEEP-966: the execution finalize gate could not get a definitive
  // on-chain answer within its bounded budget (receipt not yet visible, or
  // RPC verification timed out) -- an infra/availability fault, not a
  // confirmed transaction outcome. Comes after the revert rule above.
  {
    pattern:
      /^On-chain verification failed.*\((receipt not found|RPC verification timed out)/i,
    errorCategory: ErrorCategory.NETWORK_RPC,
    errorType: ExecutionErrorType.SYSTEM,
    code: "N-0001",
  },
  // User-config: missing or unrecognized network input. Unanchored so
  // step-wrapped forms (`Failed to check balance: Network is required`) still
  // match. Must come AFTER the RPC failover rules above: provider response
  // bodies embedded in exhaustion messages can themselves contain phrases like
  // `Unsupported network:`, and those must stay system/N-0001.
  {
    pattern: /Network is required/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  {
    pattern: /Unsupported network:/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // Typed-data signing against a chain the platform does not support -- the
  // author picked it. Anchored on the field name for the same reason as the
  // rules above: the phrase can appear inside a quoted provider response.
  {
    pattern: /^typedData\.domain\.chainId\b.*is not a supported chain/i,
    errorCategory: ErrorCategory.VALIDATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // User-config: webhook hostname does not resolve -- the configured URL points
  // at a host that does not exist. Must come before the generic webhook rule.
  {
    pattern: /^Failed to send webhook:.*getaddrinfo/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // External dependency: webhook send transport failure (ECONNRESET, timeout,
  // TLS, connection refused) to the customer's configured endpoint -- we
  // attempted the send and the endpoint did not complete it. A non-2xx response
  // is caught by the `^HTTP \d{3}:` rules below.
  {
    pattern: /^Failed to send webhook/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: ExecutionErrorType.EXTERNAL,
    code: null,
  },
  // External dependency: endpoint answered with a 5xx (webhook/safe/discord/etc.)
  // -- the upstream service itself is failing, not the author's request. Must
  // come before the general `^HTTP \d{3}:` user rule.
  {
    pattern: /^HTTP 5\d{2}:/,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: ExecutionErrorType.EXTERNAL,
    code: null,
  },
  // User-config: endpoint answered with a non-5xx non-2xx (401/403/404/400,
  // etc.) -- a bad request/auth the author configured.
  {
    pattern: /^HTTP \d{3}:/,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // User-config: HTTP request step DNS resolution failed -- the configured URL's
  // hostname does not resolve. Must come before the generic transport rule.
  {
    pattern: /^HTTP request failed:.*getaddrinfo/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // External dependency: HTTP request step got a 5xx from the endpoint -- the
  // upstream service is failing. Must come before the general status rule.
  {
    pattern: /^HTTP request failed\s+with status\s+5\d{2}/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: ExecutionErrorType.EXTERNAL,
    code: null,
  },
  // User-config: HTTP request step got a non-5xx non-2xx status -- a bad
  // request/auth the author configured. Falls below the more specific
  // `Missing template variable` / `GET/HEAD method` rules above.
  {
    pattern: /^HTTP request failed\s+with status\s+\d+/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: ExecutionErrorType.USER,
    code: null,
  },
  // External dependency: HTTP request step reached DNS but the endpoint did not
  // respond (ECONNRESET, connection timeout, TLS). DNS-resolution failures are
  // caught by the getaddrinfo rule above and stay "user".
  {
    pattern: /^HTTP request failed:\s/i,
    errorCategory: ErrorCategory.EXTERNAL_SERVICE,
    errorType: ExecutionErrorType.EXTERNAL,
    code: null,
  },

  // System: database / persistence layer
  {
    pattern: /^Database query failed/i,
    errorCategory: ErrorCategory.DATABASE,
    errorType: ExecutionErrorType.SYSTEM,
    code: "C-0002",
  },
  {
    pattern: /^Failed query:/i,
    errorCategory: ErrorCategory.DATABASE,
    errorType: ExecutionErrorType.SYSTEM,
    code: "C-0002",
  },
  {
    pattern: /^getaddrinfo .*\.rds\.amazonaws\.com/i,
    errorCategory: ErrorCategory.DATABASE,
    errorType: ExecutionErrorType.SYSTEM,
    code: "C-0002",
  },

  // System: workflow engine / executor
  {
    pattern: /^Execution timed out/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: ExecutionErrorType.SYSTEM,
    code: "E-0001",
  },
  {
    pattern: /^Workflow terminated by SIGTERM/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    errorType: ExecutionErrorType.SYSTEM,
    code: "P-0003",
  },
  {
    pattern: /^Step ".*" exceeded max retries/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: ExecutionErrorType.SYSTEM,
    code: "E-0002",
  },
  {
    pattern: /^Unknown action type:/i,
    errorCategory: ErrorCategory.WORKFLOW_ENGINE,
    errorType: ExecutionErrorType.SYSTEM,
    code: "E-0003",
  },
  // Writes from one wallet are serialized, so exhausting the lock budget means
  // the workflow is asking for more throughput than a single wallet has. That
  // is the author's configuration, not an engine fault: user error, no code.
  {
    pattern: /^Wallet is saturated: could not acquire the nonce lock/i,
    errorCategory: ErrorCategory.CONFIGURATION,
    errorType: ExecutionErrorType.USER,
    code: null,
  },

  // System: deploy bugs / missing modules / missing secrets
  {
    pattern: /^Cannot find module/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    errorType: ExecutionErrorType.SYSTEM,
    code: "C-0003",
  },
  {
    pattern: /must be set\s*$/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    errorType: ExecutionErrorType.SYSTEM,
    code: "C-0003",
  },
  {
    pattern: /^Failed to initialize organization wallet/i,
    errorCategory: ErrorCategory.INFRASTRUCTURE,
    errorType: ExecutionErrorType.SYSTEM,
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
      errorType: ExecutionErrorType.SYSTEM,
      code: DEFAULT_SYSTEM_ERROR_CODE,
    };
  }

  const trimmed = errorMessage.trim();
  if (trimmed.length === 0) {
    return {
      errorCategory: ErrorCategory.WORKFLOW_ENGINE,
      errorType: ExecutionErrorType.SYSTEM,
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
    errorType: ExecutionErrorType.SYSTEM,
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

/**
 * Override a string-derived classification with an authoritative `errorType`
 * declared at the failure site (a step that knows it failed against a
 * third-party dependency, etc.). The message classifier reverse-engineers the
 * type from prose, which is fragile for the long tail of integration error
 * shapes; when a step tags its failure, that tag wins.
 *
 * `errorCategory` and `code` are kept coherent with the resulting type: an
 * external or user failure carries no system code, and an external failure is
 * categorized `EXTERNAL_SERVICE`. A "system" tag keeps the classifier's code
 * (or the default system code) so it still pages with a stable identifier.
 *
 * A null/undefined hint, or a hint that already agrees with the classifier,
 * returns the classification unchanged.
 */
export function applyErrorClassHint(
  classification: ExecutionErrorClassification,
  hint: ExecutionErrorType | null | undefined
): ExecutionErrorClassification {
  if (!hint || hint === classification.errorType) {
    return classification;
  }
  if (hint === ExecutionErrorType.EXTERNAL) {
    return {
      errorCategory: ErrorCategory.EXTERNAL_SERVICE,
      errorType: ExecutionErrorType.EXTERNAL,
      code: null,
    };
  }
  if (hint === ExecutionErrorType.USER) {
    return {
      errorCategory: classification.errorCategory,
      errorType: ExecutionErrorType.USER,
      code: null,
    };
  }
  return {
    errorCategory: classification.errorCategory,
    errorType: ExecutionErrorType.SYSTEM,
    code: classification.code ?? DEFAULT_SYSTEM_ERROR_CODE,
  };
}
