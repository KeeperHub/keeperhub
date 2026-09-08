/**
 * Typed node and edge builder helpers for the deterministic workflow factory.
 *
 * Each helper emits the canonical WorkflowNode / WorkflowEdge wire-shape
 * verified against real fixtures in tests/fixtures/workflows.ts and
 * lib/test-data/build-workflow.ts.
 *
 * CRITICAL wire-shape invariants (a malformed shape broke workflow saves once):
 *   - node.type MUST equal node.data.type ("trigger" | "action")
 *   - actionType lives at node.data.config.actionType (never node.data.actionType)
 *   - Schedule trigger: config.scheduleCron / config.scheduleTimezone (not cron/timezone)
 *   - Condition out-edges MUST carry sourceHandle "true" | "false"
 *   - config.network is always a string (String(chainId))
 *
 * No server-only imports — safe to call from tests and client-side code.
 */
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";

// ---------------------------------------------------------------------------
// Prefill helpers
// ---------------------------------------------------------------------------

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE_UNIT_AMOUNT_RE = /^\d+$/;

/**
 * Return the confirmInputs value when it is a real 0x address, otherwise the
 * given `{{placeholder}}`. The engine prefills confirmInputs with scanned
 * values, but test fixtures and degraded paths may carry placeholder prose
 * ("Your wallet address to monitor") that must never land in node config.
 */
export function resolveAddressPrefill(
  confirmValue: string | undefined,
  placeholder: string
): string {
  if (confirmValue !== undefined && HEX_ADDRESS_RE.test(confirmValue)) {
    return confirmValue;
  }
  return placeholder;
}

/**
 * Return the confirmInputs value when it is a raw base-unit integer string,
 * otherwise the given `{{placeholder}}`. Used for prefilled thresholds.
 */
export function resolveAmountPrefill(
  confirmValue: string | undefined,
  placeholder: string
): string {
  if (confirmValue !== undefined && BASE_UNIT_AMOUNT_RE.test(confirmValue)) {
    return confirmValue;
  }
  return placeholder;
}

// ---------------------------------------------------------------------------
// Position constants — nodes laid out left-to-right, 250px apart
// ---------------------------------------------------------------------------

const STEP_X_START = 100;
const STEP_X_GAP = 250;
const STEP_Y = 200;

function stepPosition(index: number): { x: number; y: number } {
  return { x: STEP_X_START + index * STEP_X_GAP, y: STEP_Y };
}

// ---------------------------------------------------------------------------
// Schedule trigger
// ---------------------------------------------------------------------------

export interface ScheduleTriggerOptions {
  cron: string;
  timezone?: string;
}

/**
 * Build a Schedule trigger node.
 *
 * Keys: scheduleCron / scheduleTimezone (not cron/timezone — those are
 * seed-builder-only keys per lib/mcp/workflow-schema-constants.ts TRIGGERS.Schedule).
 */
export function buildScheduleTrigger(
  id: string,
  options: ScheduleTriggerOptions,
  positionIndex = 0
): WorkflowNode {
  return {
    id,
    type: "trigger",
    position: stepPosition(positionIndex),
    data: {
      type: "trigger",
      label: "Schedule Trigger",
      config: {
        triggerType: "Schedule",
        scheduleCron: options.cron,
        scheduleTimezone: options.timezone ?? "UTC",
      },
      status: "idle",
    },
  };
}

// ---------------------------------------------------------------------------
// Read-contract action node
// ---------------------------------------------------------------------------

export interface ReadContractOptions {
  label: string;
  description?: string;
  network: string;
  contractAddress: string;
  abi: string;
  abiFunction: string;
  functionArgs: string;
}

/**
 * Build a web3/read-contract action node.
 *
 * actionType lives at data.config.actionType (wire-shape invariant, see header).
 */
export function buildReadContractNode(
  id: string,
  options: ReadContractOptions,
  positionIndex = 1
): WorkflowNode {
  return {
    id,
    type: "action",
    position: stepPosition(positionIndex),
    data: {
      type: "action",
      label: options.label,
      description: options.description,
      config: {
        actionType: "web3/read-contract",
        network: options.network,
        contractAddress: options.contractAddress,
        abi: options.abi,
        abiFunction: options.abiFunction,
        functionArgs: options.functionArgs,
      },
      status: "idle",
    },
  };
}

// ---------------------------------------------------------------------------
// Check-token-balance action node
// ---------------------------------------------------------------------------

export interface CheckTokenBalanceOptions {
  label: string;
  network: string;
  address: string;
  tokenConfig: string;
}

/**
 * Build a web3/check-token-balance action node.
 *
 * Output fields: balance.balance, balance.balanceRaw, balance.symbol, etc.
 * (from plugins/web3/index.ts outputFields for check-token-balance)
 */
export function buildCheckTokenBalanceNode(
  id: string,
  options: CheckTokenBalanceOptions,
  positionIndex = 1
): WorkflowNode {
  return {
    id,
    type: "action",
    position: stepPosition(positionIndex),
    data: {
      type: "action",
      label: options.label,
      config: {
        actionType: "web3/check-token-balance",
        network: options.network,
        address: options.address,
        tokenConfig: options.tokenConfig,
      },
      status: "idle",
    },
  };
}

// ---------------------------------------------------------------------------
// Check-balance (native token) action node
// ---------------------------------------------------------------------------

export interface CheckBalanceOptions {
  label: string;
  network: string;
  address: string;
}

/**
 * Build a web3/check-balance action node (native token balance).
 *
 * Output fields are flat: balance (human-readable), balanceWei (wei string).
 * (from plugins/web3/index.ts outputFields for check-balance)
 */
export function buildCheckBalanceNode(
  id: string,
  options: CheckBalanceOptions,
  positionIndex = 1
): WorkflowNode {
  return {
    id,
    type: "action",
    position: stepPosition(positionIndex),
    data: {
      type: "action",
      label: options.label,
      config: {
        actionType: "web3/check-balance",
        network: options.network,
        address: options.address,
      },
      status: "idle",
    },
  };
}

// ---------------------------------------------------------------------------
// Condition action node
// ---------------------------------------------------------------------------

export interface ConditionOptions {
  label: string;
  slug: string;
  leftOperand: string;
  operator: string;
  rightOperand: string;
}

/**
 * Build a Condition action node.
 *
 * conditionConfig group.id and rules[0].id are derived from the slug to
 * guarantee uniqueness (Pitfall 2 from 52-RESEARCH.md).
 */
export function buildConditionNode(
  id: string,
  options: ConditionOptions,
  positionIndex = 2
): WorkflowNode {
  const groupId = `${options.slug}-group`;
  const ruleId = `${options.slug}-rule-0`;
  const expression = `${options.leftOperand} ${options.operator} ${options.rightOperand}`;

  return {
    id,
    type: "action",
    position: stepPosition(positionIndex),
    data: {
      type: "action",
      label: options.label,
      config: {
        actionType: "Condition",
        // condition: expression string used by lib/workflow/codegen/sdk.ts and
        // as a fallback in resolver.ts when conditionConfig.group is absent.
        // The runtime evaluator (resolver.ts) always prefers conditionConfig.group
        // when present, so this field is not evaluated at execution time.
        // Keep both in sync to avoid drift in codegen output.
        condition: expression,
        conditionConfig: {
          group: {
            id: groupId,
            logic: "AND",
            rules: [
              {
                id: ruleId,
                leftOperand: options.leftOperand,
                operator: options.operator,
                rightOperand: options.rightOperand,
              },
            ],
          },
        },
      },
      status: "idle",
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP Request alert action node
// ---------------------------------------------------------------------------

export interface HttpAlertOptions {
  label?: string;
  bodyTemplate: string;
}

/**
 * Build an HTTP Request action node used as the default alert step.
 *
 * HTTP Request requires no credentials (unlike discord/send-message),
 * so it is the factory default for alert nodes (resolved in 52-RESEARCH.md).
 */
export function buildHttpAlertNode(
  id: string,
  options: HttpAlertOptions,
  positionIndex = 3
): WorkflowNode {
  return {
    id,
    type: "action",
    position: stepPosition(positionIndex),
    data: {
      type: "action",
      label: options.label ?? "Send Alert",
      config: {
        actionType: "HTTP Request",
        endpoint: "https://your-webhook-endpoint.example.com",
        httpMethod: "POST",
        httpBody: options.bodyTemplate,
        httpHeaders: "{}",
      },
      status: "idle",
    },
  };
}

// ---------------------------------------------------------------------------
// Email alert action node (sendgrid/send-email)
// ---------------------------------------------------------------------------

export interface EmailAlertOptions {
  label?: string;
  subject: string;
  bodyTemplate: string;
  /**
   * Recipient; defaults to empty. The user configures it on the node in the
   * workflow builder after choosing the workflow (deliberate: no email is
   * known at anonymous scan time and no confirm-screen field is wanted).
   */
  emailTo?: string;
}

/**
 * Build a sendgrid/send-email action node used as the default alert step.
 *
 * The sendgrid plugin requires no user credentials (requiresCredentials:
 * false — it uses the KeeperHub SendGrid API key by default), so email is a
 * zero-setup alert channel for the scan funnel, unlike the previous HTTP
 * webhook default which pointed at a placeholder endpoint a generic user
 * would never have.
 */
export function buildEmailAlertNode(
  id: string,
  options: EmailAlertOptions,
  positionIndex = 3
): WorkflowNode {
  return {
    id,
    type: "action",
    position: stepPosition(positionIndex),
    data: {
      type: "action",
      label: options.label ?? "Email Me",
      config: {
        actionType: "sendgrid/send-email",
        emailTo: options.emailTo ?? "",
        emailSubject: options.subject,
        emailBody: options.bodyTemplate,
      },
      status: "idle",
    },
  };
}

// ---------------------------------------------------------------------------
// Edge builder
// ---------------------------------------------------------------------------

/**
 * Build a workflow edge.
 *
 * All edges use type "default".
 * Condition out-edges require sourceHandle "true" | "false".
 */
export function buildEdge(
  source: string,
  target: string,
  sourceHandle?: "true" | "false"
): WorkflowEdge {
  const id = `e-${source}-${target}`;
  if (sourceHandle !== undefined) {
    return { id, source, target, type: "default", sourceHandle };
  }
  return { id, source, target, type: "default" };
}
