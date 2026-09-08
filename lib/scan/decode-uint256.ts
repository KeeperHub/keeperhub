import "server-only";

import { ethers } from "ethers";

/**
 * Decode a single uint256 from ABI-encoded return data.
 * Returns null on decode failure (malformed data, empty returnData "0x").
 */
export function decodeUint256(returnData: string): bigint | null {
  if (!returnData || returnData === "0x") {
    return null;
  }
  try {
    const [value] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint256"],
      returnData
    );
    return value as bigint;
  } catch {
    return null;
  }
}
