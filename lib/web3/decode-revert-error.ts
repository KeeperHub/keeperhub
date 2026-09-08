import { ethers } from "ethers";
import { redactAllUrls } from "@/lib/rpc/scrub-rpc-urls";

/**
 * Well-known custom error selectors that appear frequently in contracts
 * but may not be included in the user-provided ABI (e.g. inherited from
 * OpenZeppelin base contracts).
 */
const COMMON_ERROR_FRAGMENTS: string[] = [
  "error Unauthorized()",
  "error OwnableUnauthorizedAccount(address account)",
  "error OwnableInvalidOwner(address owner)",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error AccessControlBadConfirmation()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InvalidApprover(address approver)",
  "error ERC20InvalidSpender(address spender)",
  "error ERC721NonexistentToken(uint256 tokenId)",
  "error ERC721InsufficientApproval(address operator, uint256 tokenId)",
  "error FailedCall()",
  "error InsufficientBalance(uint256 balance, uint256 needed)",
  "error AddressInsufficientBalance(address account)",
  "error ReentrancyGuardReentrantCall()",
  "error InvalidInitialization()",
  "error NotInitializing()",
  "error MathOverflowedMulDiv()",
  "error SafeERC20FailedOperation(address token)",
  "error NotAuthorized()",
  "error InsufficientLiquidity()",
  "error InsufficientBalance()",
  "error InvalidAmount()",
  "error InvalidAddress()",
  "error Expired()",
  "error AlreadyInitialized()",
];

const COMMON_ERRORS_INTERFACE = new ethers.Interface(COMMON_ERROR_FRAGMENTS);

function formatDecodedError(decoded: ethers.ErrorDescription): string {
  if (decoded.args.length === 0) {
    return decoded.name;
  }
  const formattedArgs = decoded.args.map((arg: unknown) =>
    typeof arg === "bigint" ? arg.toString() : String(arg)
  );
  return `${decoded.name}(${formattedArgs.join(", ")})`;
}

/**
 * Attempt to decode revert data from an ethers.js CALL_EXCEPTION error.
 *
 * Tries three strategies in order:
 * 1. Parse against the contract's own ABI (catches contract-specific errors)
 * 2. Parse against common OpenZeppelin/standard error selectors
 * 3. Decode as a standard string revert reason (require("message"))
 *
 * Returns a human-readable string, or undefined if decoding fails entirely.
 */
export function decodeRevertReason(
  error: unknown,
  contractInterface?: ethers.Interface
): string | undefined {
  const revertData = extractRevertData(error);
  if (!revertData || revertData === "0x") {
    return;
  }

  // 1. Try the contract's own ABI
  if (contractInterface) {
    try {
      const decoded = contractInterface.parseError(revertData);
      if (decoded) {
        return formatDecodedError(decoded);
      }
    } catch {
      // Not in this ABI
    }
  }

  // 2. Try common error selectors
  try {
    const decoded = COMMON_ERRORS_INTERFACE.parseError(revertData);
    if (decoded) {
      return formatDecodedError(decoded);
    }
  } catch {
    // Not a known common error
  }

  // 3. Try standard string revert (Error(string))
  try {
    const reason = ethers.AbiCoder.defaultAbiCoder().decode(
      ["string"],
      ethers.dataSlice(revertData, 4)
    );
    if (reason[0]) {
      return String(reason[0]);
    }
  } catch {
    // Not a string revert
  }

  return;
}

const ETHERS_VERSION_FRAGMENT_RE = /,?\s*version=[\w.+-]+/g;

type DecodeFailure = {
  code?: unknown;
  value?: unknown;
  info?: { method?: unknown; signature?: unknown };
};

function findFunctionOutputs(
  contractInterface: ethers.Interface | undefined,
  key: string | undefined
): readonly ethers.ParamType[] | undefined {
  if (!(contractInterface && key)) {
    return;
  }
  try {
    return contractInterface.getFunction(key)?.outputs;
  } catch {
    // Ambiguous or absent in this ABI.
    return;
  }
}

/**
 * The raw ethers BAD_DATA text describes the decoder's problem, not the
 * caller's. The supplied ABI is the one place worth looking, so name it.
 */
function describeOutputMismatch(
  error: unknown,
  contractInterface?: ethers.Interface
): string | undefined {
  if (!error || typeof error !== "object") {
    return;
  }
  const err = error as DecodeFailure;
  if (err.code !== "BAD_DATA" || typeof err.value !== "string") {
    return;
  }

  const method =
    typeof err.info?.method === "string" ? err.info.method : undefined;
  const signature =
    typeof err.info?.signature === "string" ? err.info.signature : undefined;
  const outputs = findFunctionOutputs(
    contractInterface,
    signature ?? method
  )?.map((output) => output.type);
  const declared =
    outputs && outputs.length > 0
      ? `${outputs.length} output${outputs.length === 1 ? "" : "s"} (${outputs.join(", ")})`
      : "a return value";
  const forFunction = method ? ` for ${method}` : "";

  if (err.value === "0x") {
    return `Contract returned no data, but the ABI you supplied declares ${declared}${forFunction}. If this function returns nothing, use outputs: [].`;
  }

  return `Contract returned ${ethers.dataLength(err.value)} bytes, which does not match the ${declared} the ABI you supplied declares${forFunction}. Check the output types against the contract.`;
}

/**
 * Build a user-facing error message for a contract call failure.
 *
 * If the revert data can be decoded, produces a message like:
 *   "Contract call failed: Unauthorized()"
 *
 * Otherwise falls back to the raw ethers.js error message, minus the
 * ethers version, which describes our internals rather than the input.
 */
export function formatContractError(
  error: unknown,
  contractInterface?: ethers.Interface,
  prefix?: string
): string {
  const label = prefix ?? "Contract call failed";

  const decoded = decodeRevertReason(error, contractInterface);
  if (decoded) {
    return `${label}: ${decoded}`;
  }

  const mismatch = describeOutputMismatch(error, contractInterface);
  if (mismatch) {
    return `${label}: ${mismatch}`;
  }

  const message = error instanceof Error ? error.message : String(error);
  // Every URL an ethers contract error carries is one of our provider
  // endpoints, so the host goes too, not just the key.
  const cleaned = redactAllUrls(
    message.replace(ETHERS_VERSION_FRAGMENT_RE, "")
  );
  return `${label}: ${cleaned}`;
}

/**
 * Pull the raw revert data out of an ethers.js error, wherever the provider
 * nested it. Returns undefined when the node returned none at all.
 *
 * Exported so callers can tell apart the two cases `decodeRevertReason`
 * collapses into `undefined`: "the node returned no revert data" (a rejected
 * estimate, an underfunded sender) versus "revert data came back but no
 * known ABI decodes it" (an unlisted custom error). The follow-up action
 * differs, so the two must not be treated as the same answer.
 */
export function extractRevertData(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return;
  }
  const err = error as Record<string, unknown>;

  // ethers.js v6 CALL_EXCEPTION puts revert data in .data
  if (typeof err.data === "string" && err.data.startsWith("0x")) {
    return err.data;
  }

  // Some errors nest it under .error
  if (err.error && typeof err.error === "object") {
    return extractRevertData(err.error);
  }

  // Some RPC errors put it in .info.error.data
  if (err.info && typeof err.info === "object") {
    return extractRevertData(err.info);
  }

  return;
}

// ---------------------------------------------------------------------------
// Optional classification layer
//
// Adds a structured `kind` tag to revert decoding so callers (workflow logs,
// step results, UI) can show a friendly section like "Kind: AllowanceExceeded"
// alongside the existing string message. Existing decoders are untouched —
// nothing here changes the output of `decodeRevertReason` or
// `formatContractError`. Use `classifyRevert` opt-in.
// ---------------------------------------------------------------------------

/**
 * Zodiac Roles modifier custom errors. Kept in a separate Interface from the
 * common-OZ list so adding them doesn't change `decodeRevertReason`'s output
 * for callers that don't opt into classification.
 */
const ROLE_ERROR_FRAGMENTS: string[] = [
  "error ConditionViolation(uint8 status, bytes32 paramOrAllowanceKey)",
  "error UnauthorizedAccount(address account)",
  "error UnacceptableMultiSendOffset()",
  "error AlreadyAssigned()",
  "error InvalidArrayConfiguration()",
];

const ROLE_ERRORS_INTERFACE = new ethers.Interface(ROLE_ERROR_FRAGMENTS);

/**
 * Friendly labels for the modifier's `Status` enum (see
 * zodiac-modifier-roles ConditionFlat.sol). Index = enum value.
 */
const ROLES_STATUS_LABELS: readonly string[] = [
  "Ok",
  "DelegateCallNotAllowed",
  "TargetAddressNotAllowed",
  "FunctionNotAllowed",
  "SendNotAllowed",
  "OrViolation",
  "NorViolation",
  "ParameterNotAllowed",
  "ParameterLessThanAllowed",
  "ParameterGreaterThanAllowed",
  "ParameterNotAMatch",
  "NotEveryArrayElementPasses",
  "NoArrayElementPasses",
  "ParameterNotSubsetOfAllowed",
  "BitmaskOverflow",
  "BitmaskNotAllowed",
  "CustomConditionViolation",
  "AllowanceExceeded",
  "CallAllowanceExceeded",
  "EtherAllowanceExceeded",
];

/**
 * Safe wallet GS-code map. Safe v1.x reverts use plain string reasons like
 * "GS013" (signature validation failed) -- they never come through as
 * custom errors, so the only way to classify them is to match the string
 * AFTER `Error(string)` decoding. Map drawn from the Safe contracts
 * source (`contracts/common/Errors.sol` and friends).
 *
 * `recovery` groups codes into a typed RevertKind so callers can render a
 * coherent recovery affordance (e.g. all signature-related GS codes share
 * the same kind even though they have distinct numeric labels).
 */
const SAFE_GS_CODES = {
  // Initialization / config
  GS000: {
    recovery: "safe-error",
    description: "Could not finish initialization",
  },
  GS001: {
    recovery: "safe-error",
    description: "Threshold needs to be defined",
  },
  // Gas accounting
  GS010: {
    recovery: "safe-insufficient-gas",
    description: "Not enough gas to execute Safe transaction",
  },
  GS011: {
    recovery: "safe-insufficient-gas",
    description: "Could not pay gas costs with ether",
  },
  GS012: {
    recovery: "safe-insufficient-gas",
    description: "Could not pay gas costs with token",
  },
  // Signatures
  GS013: {
    recovery: "safe-signature-invalid",
    description: "Safe tx failed; signature validation failed",
  },
  GS014: {
    recovery: "safe-signature-invalid",
    description: "Signatures data too short",
  },
  GS017: {
    recovery: "safe-signature-invalid",
    description: "Invalid contract signature provided",
  },
  GS020: {
    recovery: "safe-signature-invalid",
    description: "Signatures data too short",
  },
  GS021: {
    recovery: "safe-signature-invalid",
    description: "Invalid contract signature location: inside static part",
  },
  GS022: {
    recovery: "safe-signature-invalid",
    description: "Invalid contract signature location: length not present",
  },
  GS023: {
    recovery: "safe-signature-invalid",
    description: "Invalid contract signature location: data not complete",
  },
  GS024: {
    recovery: "safe-signature-invalid",
    description: "Invalid contract signature provided",
  },
  GS025: {
    recovery: "safe-signature-invalid",
    description: "Hash has not been approved",
  },
  GS026: {
    recovery: "safe-signature-invalid",
    description: "Invalid owner provided",
  },
  GS030: {
    recovery: "safe-not-authorized",
    description: "Only owners can approve a hash",
  },
  GS031: {
    recovery: "safe-not-authorized",
    description: "Method can only be called from this contract",
  },
  // Modules
  GS100: {
    recovery: "safe-error",
    description: "Modules have already been initialized",
  },
  GS101: {
    recovery: "safe-error",
    description: "Invalid module address provided",
  },
  GS102: {
    recovery: "safe-error",
    description: "Module has already been added",
  },
  GS103: {
    recovery: "safe-error",
    description: "Invalid prevModule, module pair provided",
  },
  GS104: {
    recovery: "safe-not-authorized",
    description: "Method can only be called from an enabled module",
  },
  GS105: {
    recovery: "safe-error",
    description: "Invalid starting point for fetching paginated modules",
  },
  GS106: {
    recovery: "safe-error",
    description: "Invalid page size for fetching paginated modules",
  },
  // Owners / threshold
  GS200: {
    recovery: "safe-error",
    description: "Owners have already been set up",
  },
  GS201: {
    recovery: "safe-error",
    description: "Threshold cannot exceed owner count",
  },
  GS202: {
    recovery: "safe-error",
    description: "Threshold needs to be greater than 0",
  },
  GS203: {
    recovery: "safe-error",
    description: "Invalid owner address provided",
  },
  GS204: { recovery: "safe-error", description: "Address is already an owner" },
  GS205: {
    recovery: "safe-error",
    description: "Invalid prevOwner, owner pair provided",
  },
  // Guards
  GS300: {
    recovery: "safe-error",
    description: "Guard does not implement IERC165",
  },
  GS301: {
    recovery: "safe-error",
    description: "Fallback handler does not implement IERC165",
  },
} as const satisfies Record<
  string,
  {
    recovery:
      | "safe-signature-invalid"
      | "safe-insufficient-gas"
      | "safe-not-authorized"
      | "safe-error";
    description: string;
  }
>;

type SafeGsCode = keyof typeof SAFE_GS_CODES;

const SAFE_GS_PATTERN = /^GS\d{3}$/;
const SAFE_GS_EMBEDDED_PATTERN = /\bGS\d{3}\b/;

function isSafeGsCode(value: string): value is SafeGsCode {
  return value in SAFE_GS_CODES;
}

export type RevertKind =
  | {
      kind: "role-condition-violation";
      /** Modifier status enum label, e.g. "AllowanceExceeded" */
      status: string;
      statusCode: number;
      /** Allowance bucket key or parameter hash (interpretation depends on status) */
      paramOrKey: string;
    }
  | { kind: "role-not-authorized"; account?: string }
  | { kind: "erc20-insufficient-balance"; balance: string; needed: string }
  | { kind: "erc20-insufficient-allowance"; allowance: string; needed: string }
  | { kind: "ownable-unauthorized"; account?: string }
  | {
      kind: "access-control-unauthorized";
      account?: string;
      neededRole?: string;
    }
  | { kind: "paused" }
  | { kind: "reentrancy" }
  | {
      kind: "safe-signature-invalid";
      gsCode: SafeGsCode;
      description: string;
    }
  | {
      kind: "safe-insufficient-gas";
      gsCode: SafeGsCode;
      description: string;
    }
  | {
      kind: "safe-not-authorized";
      gsCode: SafeGsCode;
      description: string;
    }
  | { kind: "safe-error"; gsCode: SafeGsCode; description: string }
  | { kind: "string-revert"; reason: string }
  | { kind: "contract-custom"; name: string }
  | { kind: "unknown" };

/**
 * Classify a Safe wallet GS-code string into a typed RevertKind. Returns
 * null if the string doesn't look like a Safe GS code so the caller can
 * fall through to the generic string-revert kind.
 */
function classifySafeGsCode(reason: string): RevertKind | null {
  if (!(SAFE_GS_PATTERN.test(reason) && isSafeGsCode(reason))) {
    return null;
  }
  const entry = SAFE_GS_CODES[reason];
  return {
    kind: entry.recovery,
    gsCode: reason,
    description: entry.description,
  };
}

function classifyRoleError(
  decoded: ethers.ErrorDescription
): RevertKind | null {
  if (decoded.name === "ConditionViolation") {
    const statusCode = Number(decoded.args[0]);
    const status = ROLES_STATUS_LABELS[statusCode] ?? `Status${statusCode}`;
    const paramOrKey = String(decoded.args[1]);
    return { kind: "role-condition-violation", status, statusCode, paramOrKey };
  }
  if (decoded.name === "UnauthorizedAccount") {
    return { kind: "role-not-authorized", account: String(decoded.args[0]) };
  }
  return null;
}

function classifyCommonError(
  decoded: ethers.ErrorDescription
): RevertKind | null {
  switch (decoded.name) {
    case "ERC20InsufficientBalance":
      return {
        kind: "erc20-insufficient-balance",
        balance: String(decoded.args[1]),
        needed: String(decoded.args[2]),
      };
    case "ERC20InsufficientAllowance":
      return {
        kind: "erc20-insufficient-allowance",
        allowance: String(decoded.args[1]),
        needed: String(decoded.args[2]),
      };
    case "OwnableUnauthorizedAccount":
      return { kind: "ownable-unauthorized", account: String(decoded.args[0]) };
    case "AccessControlUnauthorizedAccount":
      return {
        kind: "access-control-unauthorized",
        account: String(decoded.args[0]),
        neededRole: String(decoded.args[1]),
      };
    case "EnforcedPause":
    case "ExpectedPause":
      return { kind: "paused" };
    case "ReentrancyGuardReentrantCall":
      return { kind: "reentrancy" };
    case "NotAuthorized":
      return { kind: "role-not-authorized" };
    default:
      return null;
  }
}

/**
 * Classify a revert into a structured `kind` for UI / logs.
 *
 * Tries: contract ABI -> Roles modifier errors -> common OZ errors ->
 * string `Error(string)` revert. Returns `{ kind: "unknown" }` if nothing
 * matches; the caller can still fall back to the raw error message via
 * `formatContractError`.
 *
 * Side-effect free; does not throw.
 */
export function classifyRevert(
  error: unknown,
  contractInterface?: ethers.Interface
): RevertKind {
  const revertData = extractRevertData(error);
  if (!revertData || revertData === "0x") {
    return { kind: "unknown" };
  }

  if (contractInterface) {
    try {
      const decoded = contractInterface.parseError(revertData);
      if (decoded) {
        const common = classifyCommonError(decoded);
        if (common) {
          return common;
        }
        return { kind: "contract-custom", name: decoded.name };
      }
    } catch {
      // not in this ABI
    }
  }

  try {
    const decoded = ROLE_ERRORS_INTERFACE.parseError(revertData);
    if (decoded) {
      const role = classifyRoleError(decoded);
      if (role) {
        return role;
      }
    }
  } catch {
    // not a Roles modifier error
  }

  try {
    const decoded = COMMON_ERRORS_INTERFACE.parseError(revertData);
    if (decoded) {
      // ethers' Interface.parseError matches the built-in `Error(string)`
      // and `Panic(uint256)` selectors. Route Error(string) through the
      // Safe-GS extractor + string-revert kind so callers get a useful
      // discriminator instead of a misleading `contract-custom: "Error"`.
      if (decoded.name === "Error" && decoded.args.length > 0) {
        const reasonStr = String(decoded.args[0]);
        const safeGs = extractSafeGsCode(reasonStr);
        if (safeGs) {
          return safeGs;
        }
        return { kind: "string-revert", reason: reasonStr };
      }
      if (decoded.name === "Panic" && decoded.args.length > 0) {
        return {
          kind: "string-revert",
          reason: `Panic(${String(decoded.args[0])})`,
        };
      }
      const common = classifyCommonError(decoded);
      if (common) {
        return common;
      }
      return { kind: "contract-custom", name: decoded.name };
    }
  } catch {
    // not a known common error
  }

  // Some revert payloads encode the string directly without the
  // Error(string) selector wrapper (e.g. low-level reverts in older
  // contracts). Fall through to a raw decode attempt before giving up.
  try {
    const reason = ethers.AbiCoder.defaultAbiCoder().decode(
      ["string"],
      ethers.dataSlice(revertData, 4)
    );
    const raw = reason[0];
    if (raw) {
      const reasonStr = String(raw);
      const safeGs = extractSafeGsCode(reasonStr);
      if (safeGs) {
        return safeGs;
      }
      return { kind: "string-revert", reason: reasonStr };
    }
  } catch {
    // not a string revert
  }

  return { kind: "unknown" };
}

/**
 * Look for an embedded Safe GS-code anywhere in a revert reason string.
 *
 * Defensive: handles
 *   - exact match: `"GS013"`
 *   - whitespace: `"  GS013  "` (trimmed)
 *   - prefixed framing: `"Safe execution failed: GS013"` (substring)
 *   - chained wrappers: `"Module call: GS104"` (matches the first GS-code)
 *   - unknown codes: `"GS999"` (not in map -> returns null so caller falls
 *     back to the generic string-revert kind rather than mislabeling)
 *
 * Returns null on null/empty input, non-Safe strings, or codes outside the
 * documented SAFE_GS_CODES map. Side-effect free; does not throw.
 */
function extractSafeGsCode(
  reason: string | null | undefined
): RevertKind | null {
  if (!reason) {
    return null;
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Match the first GS-code anywhere in the string (\b for word-boundary so
  // we don't match GS01300 inside a wider numeric token).
  const match = trimmed.match(SAFE_GS_EMBEDDED_PATTERN);
  if (!match) {
    return null;
  }
  const code = match[0];
  if (!isSafeGsCode(code)) {
    // Looks like a GS code but not one we know about; let it pass through
    // as a generic string-revert so the operator still sees the raw text.
    return null;
  }
  return classifySafeGsCode(code);
}
