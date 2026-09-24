import type { AbiFunctionEntry } from "@/lib/abi/types";
import { PolicyRiskClass } from "@/lib/policy/catalog/constants";

type NamePatterns = {
  exact: readonly string[];
  prefix: readonly string[];
};

/**
 * Write-function name patterns per risk class, in priority order. A name is
 * tested against every class in this order and takes the first that matches,
 * so `transferOwnership` classifies as access control rather than as a value
 * transfer, and `emergencyWithdraw` as emergency rather than position
 * management.
 */
const CLASS_PATTERNS: readonly [PolicyRiskClass, NamePatterns][] = [
  [
    PolicyRiskClass.ACCESS_CONTROL,
    {
      exact: [
        "transferownership",
        "renounceownership",
        "grantrole",
        "revokerole",
        "renouncerole",
        "setowner",
        "addowner",
        "removeowner",
        "swapowner",
        "changeadmin",
        "setadmin",
        "setthreshold",
        "enablemodule",
        "disablemodule",
        "setguard",
        "setimplementation",
        "acceptownership",
      ],
      prefix: ["upgradeto", "setrole", "grantpermission"],
    },
  ],
  [
    PolicyRiskClass.EMERGENCY,
    {
      exact: ["pause", "unpause", "shutdown", "freeze", "unfreeze", "kill"],
      prefix: ["emergency", "rescue", "sweep"],
    },
  ],
  [
    PolicyRiskClass.APPROVAL,
    {
      exact: [
        "approve",
        "setapprovalforall",
        "increaseallowance",
        "decreaseallowance",
        "permit",
      ],
      prefix: [],
    },
  ],
  [
    PolicyRiskClass.VALUE_TRANSFER,
    {
      exact: [
        "transfer",
        "transferfrom",
        "safetransferfrom",
        "safetransfer",
        "send",
        "sendvalue",
      ],
      prefix: ["withdrawto", "transferto"],
    },
  ],
  [
    PolicyRiskClass.POSITION_MANAGEMENT,
    {
      exact: [
        "supply",
        "deposit",
        "withdraw",
        "borrow",
        "repay",
        "swap",
        "stake",
        "unstake",
        "redeem",
        "mint",
        "burn",
        "harvest",
        "claim",
        "compound",
        "rebalance",
        "liquidate",
        "enter",
        "exit",
      ],
      prefix: [
        "swapexact",
        "swaptokens",
        "addliquidity",
        "removeliquidity",
        "increaseliquidity",
        "decreaseliquidity",
        "flashloan",
        "repaywith",
        "supplywith",
        "depositfor",
        "withdrawfrom",
      ],
    },
  ],
];

function matches(normalized: string, patterns: NamePatterns): boolean {
  if (patterns.exact.includes(normalized)) {
    return true;
  }
  return patterns.prefix.some((prefix) => normalized.startsWith(prefix));
}

/**
 * The risk class of an ABI function.
 *
 * `stateMutability` is authoritative for reads and is checked before any name
 * pattern, so a view function whose name resembles a write (`maxDeposit`,
 * `previewRedeem`) classifies as a read. Name patterns apply only to functions
 * that can change state.
 */
export function deriveRiskClass(entry: AbiFunctionEntry): PolicyRiskClass {
  if (entry.stateMutability === "view" || entry.stateMutability === "pure") {
    return PolicyRiskClass.READ;
  }

  const normalized = entry.name.toLowerCase();
  for (const [riskClass, patterns] of CLASS_PATTERNS) {
    if (matches(normalized, patterns)) {
      return riskClass;
    }
  }

  return PolicyRiskClass.UNKNOWN;
}

/**
 * Functions that forward arbitrary calls on the caller's behalf.
 *
 * Permitting one voids the selector guard for that contract, because what
 * executes is chosen by the calldata rather than by the selector the policy
 * matched. The builder surfaces this as a security finding rather than
 * silently treating it as an ordinary write.
 */
const DISPATCHER_NAMES: readonly string[] = [
  "multicall",
  "aggregate",
  "aggregate3",
  "tryaggregate",
  "execute",
  "exectransaction",
  "executebatch",
  "batch",
  "forward",
  "proxycall",
  "functioncall",
  "delegate",
];

export function isDispatcherFunction(entry: AbiFunctionEntry): boolean {
  if (entry.stateMutability === "view" || entry.stateMutability === "pure") {
    return false;
  }
  return DISPATCHER_NAMES.includes(entry.name.toLowerCase());
}
