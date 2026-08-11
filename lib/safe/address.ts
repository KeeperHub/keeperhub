/**
 * Pure helpers for Safe deployment: setup calldata encoding, deterministic
 * salt derivation, and event parsing to recover the proxy address post-deploy.
 *
 * No network calls, no DB access -- intentionally easy to unit-test.
 */

import { ethers } from "ethers";

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

/**
 * Safe v1.4.1 setup() ABI. Called once against a freshly-deployed proxy
 * to initialize owners, threshold, and the fallback handler.
 */
export const SAFE_SETUP_ABI = [
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
] as const;

/**
 * SafeProxyFactory v1.4.1 ABI -- only the pieces we touch at deploy time.
 */
export const SAFE_PROXY_FACTORY_ABI = [
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "function proxyCreationCode() view returns (bytes)",
  "event ProxyCreation(address indexed proxy, address singleton)",
] as const;

const safeSetupInterface = new ethers.Interface(SAFE_SETUP_ABI);
const safeProxyFactoryInterface = new ethers.Interface(SAFE_PROXY_FACTORY_ABI);

export type BuildSetupCalldataOptions = {
  owners: string[];
  threshold: number;
  fallbackHandler: string;
};

/**
 * Encode the Safe.setup() call used as `initializer` in createProxyWithNonce.
 * A plain (non-module, non-payment) Safe only populates owners, threshold,
 * and fallback handler -- the rest of the arguments are zero-valued.
 */
export function buildSetupCalldata(options: BuildSetupCalldataOptions): string {
  const { owners, threshold, fallbackHandler } = options;

  if (owners.length === 0) {
    throw new Error("Safe setup requires at least one owner");
  }
  if (threshold < 1 || threshold > owners.length) {
    throw new Error(
      `Safe threshold must be between 1 and ${owners.length}, got ${threshold}`
    );
  }

  return safeSetupInterface.encodeFunctionData("setup", [
    owners,
    threshold,
    ZERO_ADDRESS,
    "0x",
    fallbackHandler,
    ZERO_ADDRESS,
    BigInt(0),
    ZERO_ADDRESS,
  ]);
}

/**
 * Derive a deterministic salt nonce per (organization, chain).
 *
 * Using the low 128 bits of keccak256("kh-safe" || orgId || chainId) keeps
 * the salt well under uint256 while giving >2^100 collision resistance across
 * all orgs on a chain. The same org always produces the same salt so the
 * Safe address is reproducible if we ever need to re-derive it.
 */
export function orgSaltNonce(organizationId: string, chainId: number): bigint {
  const encoded = ethers.solidityPacked(
    ["string", "string", "uint256"],
    ["kh-safe", organizationId, BigInt(chainId)]
  );
  const hash = ethers.keccak256(encoded);
  // Take the low 16 bytes (32 hex chars + 0x prefix = 34 chars).
  const low128 = BigInt(`0x${hash.slice(-32)}`);
  return low128;
}

/**
 * Extract the deployed Safe address from a createProxyWithNonce tx receipt.
 *
 * SafeProxyFactory emits `ProxyCreation(address proxy, address singleton)`
 * as the only event. We match by topic0 and pull `proxy` out of the event
 * args.
 */
export function parseProxyCreationEvent(
  receipt: ethers.TransactionReceipt,
  factoryAddress: string
): string {
  const factoryLower = factoryAddress.toLowerCase();
  const topic = safeProxyFactoryInterface.getEvent("ProxyCreation")?.topicHash;
  if (!topic) {
    throw new Error("ProxyCreation event missing from factory ABI");
  }

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== factoryLower) {
      continue;
    }
    if (log.topics[0] !== topic) {
      continue;
    }
    const parsed = safeProxyFactoryInterface.parseLog({
      topics: Array.from(log.topics),
      data: log.data,
    });
    if (!parsed) {
      continue;
    }
    const proxy = parsed.args.proxy as string;
    return ethers.getAddress(proxy);
  }

  throw new Error(
    "Safe ProxyCreation event not found in transaction receipt logs"
  );
}

/**
 * Encode the SafeProxyFactory.createProxyWithNonce call used to send the
 * deployment transaction. Exposed mainly so the deployment orchestrator
 * can pass raw calldata through the transaction-manager pipeline.
 */
export function buildCreateProxyCalldata(options: {
  singleton: string;
  initializer: string;
  saltNonce: bigint;
}): string {
  return safeProxyFactoryInterface.encodeFunctionData("createProxyWithNonce", [
    options.singleton,
    options.initializer,
    options.saltNonce,
  ]);
}

/**
 * Predict the CREATE2 address of the Safe proxy BEFORE the deploy tx
 * actually executes. Mirrors what `SafeProxyFactory.createProxyWithNonce`
 * does on-chain:
 *
 *   salt        = keccak256(keccak256(initializer) || saltNonce)
 *   initCode    = proxyCreationCode ++ abi.encode(singleton)
 *   address     = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
 *
 * `proxyCreationCode` is fetched from the factory at call time rather than
 * hardcoded so future Safe-version bumps don't drift this helper. Caller
 * supplies an ethers Provider so the read can route through the
 * RpcProviderManager's failover if desired.
 *
 * Returns a checksummed (EIP-55) address. Pure once the proxyCreationCode
 * has been fetched; no side effects.
 */
export async function computeSafeProxyAddress(options: {
  provider: ethers.Provider;
  factory: string;
  singleton: string;
  initializer: string;
  saltNonce: bigint;
}): Promise<string> {
  const { provider, factory, singleton, initializer, saltNonce } = options;
  const factoryContract = new ethers.Contract(
    factory,
    SAFE_PROXY_FACTORY_ABI,
    provider
  );
  const proxyCreationCode =
    (await factoryContract.proxyCreationCode()) as string;
  const salt = ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "uint256"],
      [ethers.keccak256(initializer), saltNonce]
    )
  );
  const initCode = ethers.concat([
    proxyCreationCode,
    ethers.AbiCoder.defaultAbiCoder().encode(["address"], [singleton]),
  ]);
  return ethers.getCreate2Address(factory, salt, ethers.keccak256(initCode));
}
