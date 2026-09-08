/**
 * Pure calldata helpers for Zodiac Roles Modifier v2.
 *
 * Everything here is stateless: no DB, no network, no signer. Orchestrators
 * pass the returned bytes into the transaction manager (wrapped in
 * safe.execTransaction for owner-signed ops or submitted directly as
 * execTransactionWithRole for the automation EOA).
 *
 * We import `rolesAbi` from zodiac-roles-sdk so we don't have to maintain a
 * second copy; ethers.Interface does the actual encoding.
 */

import { ethers } from "ethers";
import { rolesAbi } from "zodiac-roles-sdk";

/**
 * Zodiac ExecutionOptions — maps to the on-chain enum. `Both` = allow both
 * Call and DelegateCall; `Send` = Call-only; `DelegateCall` = delegate only;
 * `None` = no execution (shouldn't normally be used for writes).
 */
export const ExecutionOptions = {
  None: 0,
  Send: 1,
  DelegateCall: 2,
  Both: 3,
} as const;

export type ExecutionOptionsValue =
  (typeof ExecutionOptions)[keyof typeof ExecutionOptions];

/**
 * Operation for execTransactionWithRole. Mirrors the Safe Operation enum.
 */
export const SafeOperation = {
  Call: 0,
  DelegateCall: 1,
} as const;

export type SafeOperationValue =
  (typeof SafeOperation)[keyof typeof SafeOperation];

const rolesInterface = new ethers.Interface(rolesAbi);

/**
 * Module ProxyFactory ABI — we only need `deployModule` and its event.
 */
export const MODULE_PROXY_FACTORY_ABI = [
  "function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ModuleProxyCreation(address indexed proxy, address indexed masterCopy)",
] as const;

const moduleProxyFactoryInterface = new ethers.Interface(
  MODULE_PROXY_FACTORY_ABI
);

/**
 * Zodiac Roles Modifier setup signature. Called once against the freshly
 * deployed proxy to initialise the modifier with its owner / avatar / target.
 * For our deployment owner = avatar = target = Safe address.
 */
const ROLES_SETUP_ABI = ["function setUp(bytes initParams)"] as const;

const rolesSetupInterface = new ethers.Interface(ROLES_SETUP_ABI);

/**
 * MultiSend ABI — we wrap multiple owner-signed calls into a single Safe
 * transaction when the install/diff touches many module methods at once.
 */
export const MULTISEND_ABI = [
  "function multiSend(bytes transactions)",
] as const;

const multisendInterface = new ethers.Interface(MULTISEND_ABI);

// ---------------------------------------------------------------------------
// Roles Modifier calldata
// ---------------------------------------------------------------------------

export function buildAssignRoleCalldata(options: {
  delegate: string;
  roleKey: string;
}): string {
  return rolesInterface.encodeFunctionData("assignRoles", [
    options.delegate,
    [options.roleKey],
    [true],
  ]);
}

export function buildUnassignRoleCalldata(options: {
  delegate: string;
  roleKey: string;
}): string {
  return rolesInterface.encodeFunctionData("assignRoles", [
    options.delegate,
    [options.roleKey],
    [false],
  ]);
}

export function buildSetDefaultRoleCalldata(options: {
  delegate: string;
  roleKey: string;
}): string {
  return rolesInterface.encodeFunctionData("setDefaultRole", [
    options.delegate,
    options.roleKey,
  ]);
}

export function buildScopeTargetCalldata(options: {
  roleKey: string;
  target: string;
}): string {
  return rolesInterface.encodeFunctionData("scopeTarget", [
    options.roleKey,
    options.target,
  ]);
}

export function buildRevokeTargetCalldata(options: {
  roleKey: string;
  target: string;
}): string {
  return rolesInterface.encodeFunctionData("revokeTarget", [
    options.roleKey,
    options.target,
  ]);
}

export function buildAllowFunctionCalldata(options: {
  roleKey: string;
  target: string;
  selector: string;
  executionOptions?: ExecutionOptionsValue;
}): string {
  return rolesInterface.encodeFunctionData("allowFunction", [
    options.roleKey,
    options.target,
    options.selector,
    options.executionOptions ?? ExecutionOptions.Send,
  ]);
}

/**
 * Condition-flat tuple used by `scopeFunction`. Matches the on-chain struct:
 *   struct ConditionFlat { uint8 parent; Operator operator; ParameterType paramType; bytes compValue; }
 * Encoded as [parent, operator, paramType, compValue] tuples.
 */
export type ConditionFlat = {
  parent: number;
  operator: number;
  paramType: number;
  compValue: string;
};

export function buildScopeFunctionCalldata(options: {
  roleKey: string;
  target: string;
  selector: string;
  conditions: ConditionFlat[];
  executionOptions?: ExecutionOptionsValue;
}): string {
  return rolesInterface.encodeFunctionData("scopeFunction", [
    options.roleKey,
    options.target,
    options.selector,
    options.conditions.map((c) => [
      c.parent,
      c.operator,
      c.paramType,
      c.compValue,
    ]),
    options.executionOptions ?? ExecutionOptions.Send,
  ]);
}

/**
 * Set or update an allowance entry. Zodiac Roles keeps a per-allowanceKey
 * bucket with balance / maxRefill / refill / period / timestamp. Spend is
 * decremented automatically by the modifier when a call wrapped by this
 * allowance executes.
 */
export function buildSetAllowanceCalldata(options: {
  allowanceKey: string;
  balance: bigint;
  maxRefill: bigint;
  refill: bigint;
  period: bigint;
  timestamp: bigint;
}): string {
  const MAX_UINT128 = BigInt(2) ** BigInt(128) - BigInt(1);
  const MAX_UINT64 = BigInt(2) ** BigInt(64) - BigInt(1);
  if (options.balance > MAX_UINT128) {
    throw new Error("balance must fit in uint128");
  }
  if (options.maxRefill > MAX_UINT128) {
    throw new Error("maxRefill must fit in uint128");
  }
  if (options.refill > MAX_UINT128) {
    throw new Error("refill must fit in uint128");
  }
  if (options.period > MAX_UINT64) {
    throw new Error("period must fit in uint64");
  }
  if (options.timestamp > MAX_UINT64) {
    throw new Error("timestamp must fit in uint64");
  }
  return rolesInterface.encodeFunctionData("setAllowance", [
    options.allowanceKey,
    options.balance,
    options.maxRefill,
    options.refill,
    options.period,
    options.timestamp,
  ]);
}

/**
 * The primary execution primitive for automation. Called by the delegate EOA
 * (our Turnkey wallet) to route a transaction through the Safe subject to
 * the role's permissions.
 */
export function buildExecTransactionWithRoleCalldata(options: {
  to: string;
  value: bigint;
  data: string;
  operation?: SafeOperationValue;
  roleKey: string;
  shouldRevert?: boolean;
}): string {
  return rolesInterface.encodeFunctionData("execTransactionWithRole", [
    options.to,
    options.value,
    options.data,
    options.operation ?? SafeOperation.Call,
    options.roleKey,
    options.shouldRevert ?? true,
  ]);
}

// ---------------------------------------------------------------------------
// Deploy + setup via ModuleProxyFactory
// ---------------------------------------------------------------------------

/**
 * Encode the `setUp(initParams)` call used as the initializer bytes when
 * deploying a Roles modifier proxy. The modifier expects
 *   abi.encode(address owner, address avatar, address target)
 * where owner = who can change roles, avatar = the Safe whose storage the
 * modifier reads, target = the Safe the modifier calls back into.
 *
 * For our single-owner threshold-1 Safe all three are the Safe itself;
 * the Safe signs any role mutation through `execTransaction`.
 */
export function buildRolesSetUpCalldata(options: {
  owner: string;
  avatar: string;
  target: string;
}): string {
  const initParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [options.owner, options.avatar, options.target]
  );
  return rolesSetupInterface.encodeFunctionData("setUp", [initParams]);
}

export function buildDeployRolesCalldata(options: {
  rolesSingleton: string;
  initializer: string;
  saltNonce: bigint;
}): string {
  return moduleProxyFactoryInterface.encodeFunctionData("deployModule", [
    options.rolesSingleton,
    options.initializer,
    options.saltNonce,
  ]);
}

/**
 * Parse the `ModuleProxyCreation(proxy, masterCopy)` event to recover the
 * freshly-deployed Roles modifier proxy address from a tx receipt.
 */
export function parseModuleProxyCreationEvent(
  receipt: ethers.TransactionReceipt,
  factoryAddress: string
): string {
  const factoryLower = factoryAddress.toLowerCase();
  const topic = moduleProxyFactoryInterface.getEvent(
    "ModuleProxyCreation"
  )?.topicHash;
  if (!topic) {
    throw new Error("ModuleProxyCreation topic missing from ABI");
  }
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== factoryLower) {
      continue;
    }
    if (log.topics[0] !== topic) {
      continue;
    }
    const parsed = moduleProxyFactoryInterface.parseLog({
      topics: Array.from(log.topics),
      data: log.data,
    });
    if (!parsed) {
      continue;
    }
    return ethers.getAddress(parsed.args.proxy as string);
  }
  throw new Error(
    "ModuleProxyCreation event not found in transaction receipt logs"
  );
}

// ---------------------------------------------------------------------------
// MultiSend batching
// ---------------------------------------------------------------------------

export type MultiSendCall = {
  to: string;
  value?: bigint;
  data: string;
  /** 0 = Call, 1 = DelegateCall */
  operation?: 0 | 1;
};

/**
 * Pack a list of calls into the `multiSend(bytes)` format. Each call is:
 *   operation (1 byte) || to (20 bytes) || value (32 bytes) || dataLen (32 bytes) || data
 */
export function packMultiSendCalls(calls: MultiSendCall[]): string {
  const packed = calls
    .map((call) => {
      const to = ethers.getAddress(call.to).slice(2).toLowerCase();
      const dataHex = call.data.startsWith("0x")
        ? call.data.slice(2)
        : call.data;
      const dataBytes = dataHex.length / 2;
      const operation = (call.operation ?? 0).toString(16).padStart(2, "0");
      const valueHex = (call.value ?? BigInt(0)).toString(16).padStart(64, "0");
      const lenHex = dataBytes.toString(16).padStart(64, "0");
      return `${operation}${to}${valueHex}${lenHex}${dataHex}`;
    })
    .join("");
  return `0x${packed}`;
}

export function buildMultiSendCalldata(calls: MultiSendCall[]): string {
  return multisendInterface.encodeFunctionData("multiSend", [
    packMultiSendCalls(calls),
  ]);
}

// ---------------------------------------------------------------------------
// Read helpers (RPC view calls used by the on-chain reconciliation path)
// ---------------------------------------------------------------------------

/**
 * Sentinel address Safe uses to start a module pagination at the head of the
 * linked list. See Safe v1.4.1 ModuleManager for the exact behaviour.
 */
const SAFE_MODULES_SENTINEL = "0x0000000000000000000000000000000000000001";
const SAFE_MODULES_PAGE_SIZE = 100;

const SAFE_MODULES_ABI = [
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] modules, address next)",
] as const;

/**
 * Read the list of enabled modules on a Safe via the on-chain
 * `getModulesPaginated` view. Returns checksummed addresses in the order the
 * Safe iterates them (newest-first). Pagination is followed transparently up
 * to a generous cap so the caller doesn't see a `next` pointer.
 */
export async function readEnabledSafeModules(
  provider: ethers.Provider,
  safeAddress: string
): Promise<string[]> {
  const contract = new ethers.Contract(safeAddress, SAFE_MODULES_ABI, provider);
  const collected: string[] = [];
  // Sentinel-based termination is the real loop guard (Safe returns
  // `next == 0x1` / `0x0` on the last page). MAX_PAGES is purely belt-and
  // braces against a malformed Safe whose linked list never terminates;
  // raised from 10 to 1000 (= 100k modules) so we silently miss nothing
  // on power-user Safes. Hitting this cap means something is wrong; we
  // throw rather than truncate so the caller can surface the diagnosis.
  // See review #923-r2 (LOW).
  const MAX_PAGES = 1000;
  let cursor = SAFE_MODULES_SENTINEL;
  let pagesFetched = 0;
  while (pagesFetched < MAX_PAGES) {
    const [modules, next] = (await contract.getModulesPaginated(
      cursor,
      SAFE_MODULES_PAGE_SIZE
    )) as [string[], string];
    for (const moduleAddress of modules) {
      collected.push(ethers.getAddress(moduleAddress));
    }
    pagesFetched += 1;
    if (
      !next ||
      next === SAFE_MODULES_SENTINEL ||
      next === ethers.ZeroAddress
    ) {
      return collected;
    }
    cursor = next;
  }
  throw new Error(
    `readEnabledSafeModules: pagination exceeded ${MAX_PAGES} pages without sentinel for safe ${safeAddress}; refusing to truncate`
  );
}

const ROLES_AVATAR_ABI = ["function avatar() view returns (address)"] as const;

/**
 * Best-effort detection of which enabled module on a Safe is its Zodiac
 * Roles modifier. Roles instances expose `avatar()` returning the Safe's
 * address; non-Roles modules either don't expose it or return something else.
 *
 * Returns the first matching module's checksummed address, or `null` if no
 * module on the Safe declares this Safe as its avatar.
 */
export async function findRolesModifierForSafe(
  provider: ethers.Provider,
  safeAddress: string,
  enabledModules: string[]
): Promise<string | null> {
  const safeLower = ethers.getAddress(safeAddress).toLowerCase();
  for (const moduleAddress of enabledModules) {
    try {
      const contract = new ethers.Contract(
        moduleAddress,
        ROLES_AVATAR_ABI,
        provider
      );
      const avatar = (await contract.avatar()) as string;
      if (avatar.toLowerCase() === safeLower) {
        return ethers.getAddress(moduleAddress);
      }
    } catch {
      // Not a Roles modifier (or not a Zodiac module). Skip.
    }
  }
  return null;
}

const ROLES_ALLOWANCES_ABI = [
  "function allowances(bytes32 key) view returns (uint128 refill, uint128 maxRefill, uint64 period, uint128 balance, uint64 timestamp)",
] as const;

export type OnChainAllowance = {
  refill: bigint;
  maxRefill: bigint;
  period: bigint;
  balance: bigint;
  timestamp: bigint;
};

/**
 * Read the on-chain allowance tuple for one bucket key. Buckets that were
 * never set return all zeros; callers should treat `maxRefill === 0n` as
 * "this bucket doesn't exist on chain."
 */
export async function readRoleAllowance(
  provider: ethers.Provider,
  rolesModifierAddress: string,
  allowanceKey: string
): Promise<OnChainAllowance> {
  const contract = new ethers.Contract(
    rolesModifierAddress,
    ROLES_ALLOWANCES_ABI,
    provider
  );
  const result = (await contract.allowances(allowanceKey)) as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  const [refill, maxRefill, period, balance, timestamp] = result;
  return { refill, maxRefill, period, balance, timestamp };
}
