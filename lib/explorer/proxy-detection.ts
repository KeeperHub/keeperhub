/**
 * RPC-based proxy contract detection
 *
 * Detects proxy contracts by checking storage slots for common proxy patterns:
 * - EIP-1967 (most common)
 * - EIP-1822 (UUPS)
 * - OpenZeppelin Transparent/Upgradeable
 * - Gnosis Safe
 * - EIP-1167 (minimal proxy/clone)
 */

import { ethers } from "ethers";
import { logWarn } from "@/lib/logging";
import { getRpcProvider } from "@/lib/rpc/provider-factory";

export type ProxyDetectionResult = {
  isProxy: boolean;
  implementationAddress?: string;
  proxyType?:
    | "eip1967"
    | "eip1822"
    | "openzeppelin"
    | "gnosis-safe"
    | "eip1167";
};

/**
 * EIP-1967 storage slot for implementation address
 * keccak256("eip1967.proxy.implementation") - 1
 *
 * Exported so `lib/scan/proxy-abi.ts` can read the slot directly without
 * re-implementing the constant.
 */
export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * EIP-1967 storage slot for admin address
 * keccak256("eip1967.proxy.admin") - 1
 */
const EIP1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

/**
 * EIP-1822 storage slot for implementation address
 * keccak256("PROXIABLE")
 */
const EIP1822_IMPLEMENTATION_SLOT =
  "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7";

/**
 * EIP-1167 minimal proxy bytecode prefix
 * 0x363d3d373d3d3d363d73 + implementation address (20 bytes) + 0x5af43d82803e903d91602b57fd5bf3
 */
const EIP1167_PREFIX = "0x363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "0x5af43d82803e903d91602b57fd5bf3";

/**
 * Extract address from storage value
 * Storage values are 32 bytes, addresses are 20 bytes (last 40 hex chars)
 */
function extractAddressFromStorage(storageValue: string): string | null {
  const hexValue = storageValue.startsWith("0x")
    ? storageValue.slice(2)
    : storageValue;

  if (hexValue.length < 40) {
    return null;
  }

  try {
    const address = ethers.getAddress(`0x${hexValue.slice(-40)}`);
    if (address && address !== ethers.ZeroAddress) {
      return address;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Check EIP-1967 proxy with admin slot detection
 * Returns both implementation address and whether admin slot is set (OpenZeppelin pattern)
 */
async function checkEip1967WithAdmin(
  provider: ethers.Provider,
  contractAddress: string
): Promise<{ implementation: string | null; hasAdmin: boolean }> {
  try {
    // Fetch implementation and admin slots in parallel
    const [implementationStorage, adminStorage] = await Promise.all([
      provider.getStorage(contractAddress, EIP1967_IMPLEMENTATION_SLOT),
      provider.getStorage(contractAddress, EIP1967_ADMIN_SLOT),
    ]);

    const implementation = extractAddressFromStorage(implementationStorage);
    const admin = extractAddressFromStorage(adminStorage);

    if (implementation) {
      const proxyType = admin ? "openzeppelin" : "eip1967";
      console.log(
        `[Proxy Detection] ${proxyType} proxy detected: ${implementation}`
      );
      return { implementation, hasAdmin: !!admin };
    }
  } catch (error) {
    console.log(
      "[Proxy Detection] EIP-1967 check failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
  return { implementation: null, hasAdmin: false };
}

/**
 * Check if a contract is an EIP-1822 (UUPS) proxy
 */
async function checkEip1822Proxy(
  provider: ethers.Provider,
  contractAddress: string
): Promise<string | null> {
  try {
    const implementation = await provider.getStorage(
      contractAddress,
      EIP1822_IMPLEMENTATION_SLOT
    );

    const address = extractAddressFromStorage(implementation);
    if (address) {
      console.log(`[Proxy Detection] EIP-1822 proxy detected: ${address}`);
      return address;
    }
  } catch (error) {
    console.log(
      "[Proxy Detection] EIP-1822 check failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
  return null;
}

/**
 * Check if a contract is a Gnosis Safe proxy
 * Gnosis Safe proxies use delegatecall to a master copy stored at slot 0
 * Verifies by calling VERSION() on the master copy
 */
async function checkGnosisSafeProxy(
  provider: ethers.Provider,
  contractAddress: string
): Promise<string | null> {
  try {
    // Gnosis Safe proxies store the master copy address at storage slot 0
    const masterCopy = await provider.getStorage(contractAddress, "0x0");
    const address = extractAddressFromStorage(masterCopy);

    if (!address) {
      return null;
    }

    // Verify it's a Safe by calling VERSION() - all Safe contracts implement this
    const safeInterface = new ethers.Interface([
      "function VERSION() view returns (string)",
    ]);

    try {
      const result = await provider.call({
        to: address,
        data: safeInterface.encodeFunctionData("VERSION"),
      });

      // If call succeeds and returns data, it's likely a Safe
      if (result && result !== "0x") {
        const version = safeInterface.decodeFunctionResult("VERSION", result);
        console.log(
          `[Proxy Detection] Gnosis Safe proxy detected: ${address} (version: ${version[0]})`
        );
        return address;
      }
    } catch {
      // VERSION() call failed - not a Safe contract
      return null;
    }
  } catch (error) {
    console.log(
      "[Proxy Detection] Gnosis Safe check failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
  return null;
}

/**
 * Check if a contract is an EIP-1167 minimal proxy (clone)
 */
async function checkEip1167Proxy(
  provider: ethers.Provider,
  contractAddress: string
): Promise<string | null> {
  try {
    const code = await provider.getCode(contractAddress);

    // EIP-1167 minimal proxy has a specific bytecode pattern
    if (code.startsWith(EIP1167_PREFIX) && code.includes(EIP1167_SUFFIX)) {
      // Extract implementation address from bytecode
      // Pattern: 0x363d3d373d3d3d363d73 + implementation (20 bytes) + 0x5af43d82803e903d91602b57fd5bf3
      const implementationHex = code.slice(
        EIP1167_PREFIX.length,
        EIP1167_PREFIX.length + 40
      );
      const address = ethers.getAddress(`0x${implementationHex}`);

      if (address && address !== ethers.ZeroAddress) {
        console.log(
          `[Proxy Detection] EIP-1167 minimal proxy detected: ${address}`
        );
        return address;
      }
    }
  } catch (error) {
    console.log(
      "[Proxy Detection] EIP-1167 check failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
  return null;
}

/**
 * Detect proxy contract via RPC calls
 * Checks multiple proxy standards with parallel execution where possible
 *
 * @param contractAddress - The contract address to check
 * @param chainId - The chain ID
 * @returns Proxy detection result with implementation address if found
 */
export async function detectProxyViaRpc(
  contractAddress: string,
  chainId: number
): Promise<ProxyDetectionResult> {
  console.log(
    `[Proxy Detection] Starting RPC-based proxy detection for ${contractAddress} on chain ${chainId}`
  );

  let rpcManager: Awaited<ReturnType<typeof getRpcProvider>>;
  try {
    rpcManager = await getRpcProvider({ chainId });
  } catch {
    logWarn(
      `[Proxy Detection] No RPC config found for chain ${chainId}, skipping detection`,
      { chain_id: String(chainId) }
    );
    return { isProxy: false };
  }

  // Run common checks in parallel with retry/failover
  const [eip1967Result, eip1167Impl] = await rpcManager.executeWithFailover(
    async (provider) =>
      Promise.all([
        checkEip1967WithAdmin(provider, contractAddress),
        checkEip1167Proxy(provider, contractAddress),
      ])
  );

  // Check EIP-1967/OpenZeppelin result first (most common)
  if (eip1967Result.implementation) {
    return {
      isProxy: true,
      implementationAddress: eip1967Result.implementation,
      proxyType: eip1967Result.hasAdmin ? "openzeppelin" : "eip1967",
    };
  }

  // Check EIP-1167 result
  if (eip1167Impl) {
    return {
      isProxy: true,
      implementationAddress: eip1167Impl,
      proxyType: "eip1167",
    };
  }

  // Check EIP-1822 (UUPS) - less common, separate call
  const eip1822Impl = await rpcManager.executeWithFailover((provider) =>
    checkEip1822Proxy(provider, contractAddress)
  );
  if (eip1822Impl) {
    return {
      isProxy: true,
      implementationAddress: eip1822Impl,
      proxyType: "eip1822",
    };
  }

  // Check Gnosis Safe (least common, requires contract call to verify)
  const gnosisImpl = await rpcManager.executeWithFailover((provider) =>
    checkGnosisSafeProxy(provider, contractAddress)
  );
  if (gnosisImpl) {
    return {
      isProxy: true,
      implementationAddress: gnosisImpl,
      proxyType: "gnosis-safe",
    };
  }

  console.log(
    `[Proxy Detection] No proxy pattern detected for ${contractAddress}`
  );
  return { isProxy: false };
}
