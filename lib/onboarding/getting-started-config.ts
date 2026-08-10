import { Bot, LineChart, Sprout } from "lucide-react";
import type { ComponentType } from "react";

/**
 * Config for the first-run "Get started" launcher (KEEP-878). Three goal
 * branches, each an ordered path to first value. The launcher UI renders purely
 * from this config + the named completion signals resolved in
 * `lib/hooks/use-getting-started.ts`.
 *
 * Placeholder seams (see the plan / KEEP-878 follow-ups) are isolated here so
 * the real backend swaps in without touching the launcher:
 *  - `getMonitorTargets` / `getYieldStrategies` return chip lists; today static,
 *    later fed by a monitor-template registry / wallet-holdings scanner behind
 *    the same signature.
 *  - step completion uses a named `SignalId` resolved by the hook; e.g.
 *    `agentConnected` currently aliases "API key exists" and can be repointed at
 *    a real agent-connection endpoint without changing any step here.
 *  - `StepAction` is a discriminated union; chips ship as `ai-prompt` now and a
 *    future curated workflow becomes `{ kind: "template", id }` with no UI churn.
 */

export type BranchKey = "agent" | "monitor" | "yield";

/** Named real-state completion signals resolved in use-getting-started.ts. */
export type SignalId =
  | "walletReady"
  | "agentConnected"
  | "ranWorkflow"
  | "alertsConnected"
  | "walletFunded"
  // `always` is a pre-checked / not-a-task step (e.g. "wallet not needed").
  | "always";

/** What a step's primary action does. */
export type StepAction =
  // Seed a preset prompt into the AI builder and open a fresh workflow.
  | { kind: "ai-prompt"; prompt: string }
  // Open an in-app overlay (api-keys, integrations, wallet) by id.
  | { kind: "deeplink"; target: DeepLinkTarget }
  // placeholder: KEEP-878 follow-up - a curated template id once the registry
  // exists; not emitted yet, here so the union is stable for swap-in.
  | { kind: "template"; id: string };

export type DeepLinkTarget =
  | "api-keys"
  | "connect-agent"
  | "integrations"
  | "wallet"
  | "wallet-fund";

export type Chip = {
  id: string;
  label: string;
  /** Preset prompt the chip seeds into the AI generator. */
  prompt: string;
  /**
   * Public HUB workflow id this chip clones into the user's org when set
   * (resolved at runtime from /api/onboarding/recommendations). When present
   * the chip duplicates that curated workflow instead of seeding the AI prompt;
   * the prompt is kept as the fallback when no starter workflow is available.
   */
  workflowId?: string;
  /** Optional UI badge (e.g. testnet-ready hint). */
  badge?: string;
};

/**
 * Structured content for the per-step "more info" dialog: a one-line summary
 * plus titled sections of bullet points, so the dialog scans as headings and
 * lists rather than a wall of prose. `{credit}` in any string is replaced with
 * the live sponsored-gas amount at render time.
 */
export type InfoSection = {
  heading: string;
  points: string[];
};

export type StepInfo = {
  summary: string;
  sections: InfoSection[];
};

export type Step = {
  key: string;
  title: string;
  description: string;
  /** Longer explanation shown in the per-step "more info" dialog. */
  info: StepInfo;
  /** Completion signal; `always` renders pre-checked. */
  signal: SignalId;
  /** Primary action triggered by clicking the step row or the info dialog CTA. */
  action?: StepAction;
  /** Label for the info-dialog action button (e.g. "Open wallet"). */
  actionLabel?: string;
  /** Offer a "Take a guided tour" button that launches the editor walkthrough. */
  offerTour?: boolean;
  /** Optional inline chips (each seeds the AI generator). */
  chips?: Chip[];
  /** Render muted (e.g. a "not needed" confirmation step). */
  muted?: boolean;
};

export type Branch = {
  key: BranchKey;
  label: string;
  icon: ComponentType<{ className?: string }>;
  steps: Step[];
};

export const SEPOLIA_CHAIN_ID = "11155111";
export const BASE_SEPOLIA_CHAIN_ID = "84532";
export const SEPOLIA_CHAIN_ID_NUM = 11_155_111;
export const BASE_SEPOLIA_CHAIN_ID_NUM = 84_532;
export const TESTNET_AAVE_SEPOLIA_POOL =
  "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";
export const TESTNET_AAVE_BASE_SEPOLIA_POOL =
  "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
export const TESTNET_READY_BADGE = "Testnet-ready";

export type WalletBalanceEntry = {
  chainId: number;
  isTestnet: boolean;
  nativeBalanceRaw: string;
};

export type TestnetWorkspace = {
  isTestnetWorkspace: boolean;
  chainId?: string;
};

export function resolveTestnetWorkspace(
  balances: WalletBalanceEntry[] | undefined
): TestnetWorkspace {
  if (!balances) {
    return { isTestnetWorkspace: false };
  }
  const fundedTestnets = balances.filter(
    (entry) => entry.isTestnet && entry.nativeBalanceRaw !== "0"
  );
  if (fundedTestnets.length === 0) {
    return { isTestnetWorkspace: false };
  }
  const sepolia = fundedTestnets.find(
    (entry) => entry.chainId === SEPOLIA_CHAIN_ID_NUM
  );
  const baseSepolia = fundedTestnets.find(
    (entry) => entry.chainId === BASE_SEPOLIA_CHAIN_ID_NUM
  );
  const picked = sepolia ?? baseSepolia ?? fundedTestnets[0];
  return {
    isTestnetWorkspace: true,
    chainId: String(picked.chainId),
  };
}

export type ChipContext = {
  walletAddress?: string | null;
  /** True when the org wallet has funds on a supported testnet. */
  isTestnetWorkspace?: boolean;
  /** Preferred testnet chain id when isTestnetWorkspace is true. */
  chainId?: string;
  /**
   * Chip slug -> live hub workflow id, resolved at runtime from
   * /api/onboarding/recommendations. When present, chips clone the hub
   * workflow instead of seeding the AI prompt.
   */
  resolvedIds?: Record<string, string>;
};

function resolveAaveWorkflowSlug(ctx: ChipContext): string {
  if (ctx.isTestnetWorkspace && ctx.chainId === SEPOLIA_CHAIN_ID) {
    return "aave-health-sepolia";
  }
  if (ctx.isTestnetWorkspace && ctx.chainId === BASE_SEPOLIA_CHAIN_ID) {
    return "aave-health-base-sepolia";
  }
  return "aave-health";
}

function buildAaveHealthChip(ctx: ChipContext): Pick<Chip, "prompt" | "badge"> {
  if (ctx.isTestnetWorkspace && ctx.chainId === SEPOLIA_CHAIN_ID) {
    return {
      prompt: `Monitor my Aave v3 health factor on Sepolia (pool ${TESTNET_AAVE_SEPOLIA_POOL}) every hour and alert me when it drops below 1.5.`,
      badge: TESTNET_READY_BADGE,
    };
  }
  if (ctx.isTestnetWorkspace && ctx.chainId === BASE_SEPOLIA_CHAIN_ID) {
    return {
      prompt: `Monitor my Aave v3 health factor on Base Sepolia (pool ${TESTNET_AAVE_BASE_SEPOLIA_POOL}) every hour and alert me when it drops below 1.5.`,
      badge: TESTNET_READY_BADGE,
    };
  }
  return {
    prompt:
      "Monitor my Aave v3 health factor every hour and alert me when it drops below 1.5.",
  };
}

function buildWhaleWithdrawalPrompt(ctx: ChipContext): string {
  if (ctx.walletAddress) {
    return `Watch for large withdrawals from ${ctx.walletAddress} and alert me when one exceeds a threshold.`;
  }
  return "Watch for large withdrawals from my tracked address and alert me when one exceeds a threshold.";
}

// placeholder: KEEP-878 follow-up - monitor event-trigger registry. Static
// today; later returns targets from the template/registry backend.
export function getMonitorTargets(ctx: ChipContext = {}): Chip[] {
  const aave = buildAaveHealthChip(ctx);
  const aaveSlug = resolveAaveWorkflowSlug(ctx);
  return [
    {
      id: "aave-health",
      label: "Aave health factor",
      prompt: aave.prompt,
      badge: aave.badge,
      workflowId: ctx.resolvedIds?.[aaveSlug],
    },
    {
      id: "whale-withdrawal",
      label: "Large withdrawal",
      prompt: buildWhaleWithdrawalPrompt(ctx),
      workflowId: ctx.resolvedIds?.["whale-withdrawal"],
    },
    {
      id: "governance",
      label: "Governance",
      prompt:
        "Notify me when a new governance proposal is created for the protocols I follow.",
      workflowId: ctx.resolvedIds?.governance,
    },
  ];
}

// placeholder: KEEP-878 follow-up - wallet-holdings scanner + strategy catalog.
// Static curated list today; later returns strategies derived from holdings.
export function getYieldStrategies(ctx: ChipContext = {}): Chip[] {
  return [
    {
      id: "sky-staking",
      label: "SKY staking optimizer",
      prompt:
        "Stake my SKY into the sUSDS vault and compound the rewards weekly.",
      workflowId: ctx.resolvedIds?.["sky-staking"],
    },
    {
      id: "steth-wrap",
      label: "stETH wrap",
      prompt: "Wrap my stETH into wstETH and hold it for yield.",
      workflowId: ctx.resolvedIds?.["steth-wrap"],
    },
    {
      id: "usds-savings",
      label: "USDS savings",
      prompt:
        "Deposit my USDS into the sUSDS savings vault and rebalance monthly.",
      workflowId: ctx.resolvedIds?.["usds-savings"],
    },
  ];
}

export function getBranches(ctx: ChipContext = {}): Branch[] {
  return [
    {
      key: "agent",
      label: "Connect an agent",
      icon: Bot,
      steps: [
        {
          key: "wallet-ready",
          title: "Wallet ready",
          description:
            "Non-custodial Turnkey wallet. First runs are gas-sponsored.",
          info: {
            summary:
              "Every account gets its own on-chain wallet, secured by Turnkey, that your workflows use to sign transactions.",
            sections: [
              {
                heading: "How it differs from your login",
                points: [
                  "How you sign in only identifies your account. It never signs transactions or holds your funds.",
                  "This KeeperHub Turnkey wallet is the only one that executes on-chain actions in your workflows.",
                  "It is non-custodial: Turnkey enforces your policies and we never hold the keys.",
                ],
              },
              {
                heading: "Monthly sponsored gas",
                points: [
                  "Every account receives {credit} of sponsored gas on mainnet.",
                  "It refreshes at the start of every month, so a baseline of runs is always covered.",
                  "It only pays network fees up to that amount. It is not a transferable balance and cannot be withdrawn, sent, or spent on anything else.",
                ],
              },
              {
                heading: "Going beyond the allowance",
                points: [
                  "For write actions past the monthly amount, add funds to the wallet address from the wallet panel.",
                  "To try things out without real value, switch to a supported test network and use testnet funds.",
                ],
              },
            ],
          },
          signal: "walletReady",
          action: { kind: "deeplink", target: "wallet-fund" },
          actionLabel: "Open wallet",
        },
        {
          key: "connect-agent",
          title: "Connect your agent",
          description:
            "Add KeeperHub to Claude, Codex, or any MCP client, then run `list my workflows` to confirm.",
          info: {
            summary:
              "Connect KeeperHub to your AI agent over MCP so it can read and run your workflows.",
            sections: [
              {
                heading: "What you can do",
                points: [
                  "Add KeeperHub as an MCP server in Claude, Codex, Gemini CLI, or any MCP client.",
                  "Sign in through your browser when prompted -- no API key required.",
                  "Ask your agent to `list my workflows` to confirm the connection.",
                ],
              },
            ],
          },
          signal: "agentConnected",
          action: { kind: "deeplink", target: "connect-agent" },
          actionLabel: "Connect agent",
        },
        {
          key: "run-workflow",
          title: "Run your first workflow",
          description: "Pick a template or describe it in a sentence.",
          info: {
            summary:
              "A workflow is a trigger plus a sequence of actions that run automatically.",
            sections: [
              {
                heading: "What you can do",
                points: [
                  "Start from a blank canvas and add a trigger and actions yourself.",
                  "Or describe what you want in plain language and let the builder scaffold it.",
                  "Mix on-chain and off-chain actions in the same workflow.",
                ],
              },
            ],
          },
          signal: "ranWorkflow",
          action: {
            kind: "ai-prompt",
            prompt:
              "Create a simple workflow that runs on a schedule and sends me a Discord message.",
          },
          actionLabel: "Open the builder",
          offerTour: true,
          chips: getMonitorTargets(ctx),
        },
      ],
    },
    {
      key: "monitor",
      label: "Monitor",
      icon: LineChart,
      steps: [
        {
          key: "pick-watch",
          title: "Pick what to watch",
          description: "Health factor, large withdrawals, governance.",
          info: {
            summary:
              "Track an on-chain signal and get notified. Monitoring is read-only, so no wallet is needed.",
            sections: [
              {
                heading: "What you can watch",
                points: [
                  "A position's health factor, alerting below a threshold.",
                  "Large withdrawals or transfers from an address.",
                  "Governance activity on the protocols you follow.",
                ],
              },
              {
                heading: "How",
                points: [
                  "Pick one of the options on the step. It scaffolds a read-only workflow with the right trigger and condition.",
                ],
              },
            ],
          },
          signal: "ranWorkflow",
          chips: getMonitorTargets(ctx),
        },
        {
          key: "connect-alerts",
          title: "Connect alerts",
          description: "Discord, Telegram, or email.",
          info: {
            summary: "Choose where your alerts are delivered.",
            sections: [
              {
                heading: "Supported channels",
                points: ["A Discord webhook.", "A Telegram bot.", "Email."],
              },
              {
                heading: "How",
                points: [
                  "Connect a channel, then reference it from any workflow step that sends an alert.",
                ],
              },
            ],
          },
          signal: "alertsConnected",
          action: { kind: "deeplink", target: "integrations" },
          actionLabel: "Connect alerts",
        },
      ],
    },
    {
      key: "yield",
      label: "Yield",
      icon: Sprout,
      steps: [
        {
          key: "fund-wallet",
          title: "Fund your wallet",
          description:
            "Add funds for write actions, or use testnet funds to try it out.",
          info: {
            summary:
              "Yield strategies sign transactions with your KeeperHub Turnkey wallet, so it needs a balance to act on.",
            sections: [
              {
                heading: "Monthly sponsored gas",
                points: [
                  "Every account gets {credit} of sponsored gas on mainnet, refreshed at the start of every month.",
                  "It covers network fees only. It is not a transferable balance and cannot be withdrawn.",
                ],
              },
              {
                heading: "Adding funds",
                points: [
                  "For write actions beyond the monthly amount, send funds to the wallet address from the wallet panel.",
                  "To try the flow without real value, switch to a supported test network and use testnet funds.",
                ],
              },
            ],
          },
          signal: "walletFunded",
          action: { kind: "deeplink", target: "wallet-fund" },
          actionLabel: "Open wallet",
        },
        {
          key: "pick-strategy",
          title: "Pick a yield strategy",
          description: "Based on what your wallet holds.",
          info: {
            summary: "Scaffold a workflow around a yield protocol action.",
            sections: [
              {
                heading: "Strategy types",
                points: [
                  "Staking optimizers.",
                  "Vault deposits.",
                  "LP positions.",
                ],
              },
              {
                heading: "How",
                points: [
                  "Pick one of the options on the step. It builds the workflow around that protocol action.",
                ],
              },
            ],
          },
          signal: "ranWorkflow",
          chips: getYieldStrategies(ctx),
        },
        {
          key: "run-automate",
          title: "Run & automate",
          description: "Compound weekly, rebalance on threshold.",
          info: {
            summary: "Put the strategy on autopilot.",
            sections: [
              {
                heading: "What you can automate",
                points: [
                  "Compound on a schedule, for example weekly.",
                  "Rebalance only when your position drifts past a threshold.",
                ],
              },
            ],
          },
          signal: "ranWorkflow",
          action: {
            kind: "ai-prompt",
            prompt:
              "Automate my yield strategy: compound weekly and rebalance when it drifts past a threshold.",
          },
          actionLabel: "Open the builder",
        },
      ],
    },
  ];
}
