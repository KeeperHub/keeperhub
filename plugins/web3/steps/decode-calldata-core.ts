/**
 * Core calldata decoding logic shared between decode-calldata and assess-risk steps.
 *
 * IMPORTANT: This file must NOT contain "use step" or be a step file.
 * It exists so that multiple step files can reuse decode logic without
 * exporting functions from "use step" files (which breaks the workflow bundler).
 */
import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { safeFetch } from "@/lib/safe-fetch";
import { db } from "@/lib/db";
import { explorerConfigs } from "@/lib/db/schema";
import { fetchContractAbi } from "@/lib/explorer";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { serializeArg } from "@/lib/web3/serialize-arg";

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";
const FOURBYTE_API_URL = "https://www.4byte.directory/api/v1/signatures/";
const HEX_PATTERN = /^0x[\da-fA-F]*$/;

export type DecodedParameter = {
  name: string;
  type: string;
  value: string;
};

export type DecodeCalldataResult =
  | {
      success: true;
      selector: string;
      functionName: string | null;
      functionSignature: string | null;
      parameters: DecodedParameter[];
      decodingSource: string;
    }
  | { success: false; error: string };

export type DecodeCalldataCoreInput = {
  calldata: string;
  contractAddress?: string;
  network?: string;
  abi?: string;
};

/**
 * Serialize a decoded value to string, handling BigInt, arrays, and objects
 */
const serializeValue = serializeArg;

/**
 * Extract named parameters from a parsed transaction fragment
 */
function extractParameters(
  fragment: ethers.FunctionFragment,
  args: ethers.Result
): DecodedParameter[] {
  const params: DecodedParameter[] = [];
  for (const [i, input] of fragment.inputs.entries()) {
    params.push({
      name: input.name || `param${i}`,
      type: input.type,
      value: serializeValue(args[i]),
    });
  }
  return params;
}

/**
 * Attempt to decode calldata using a known ABI
 */
function tryDecodeWithAbi(
  calldata: string,
  abi: ethers.InterfaceAbi
): {
  functionName: string;
  functionSignature: string;
  parameters: DecodedParameter[];
} | null {
  try {
    const iface = new ethers.Interface(abi);
    const parsed = iface.parseTransaction({ data: calldata });
    if (!parsed) {
      return null;
    }
    return {
      functionName: parsed.name,
      functionSignature: parsed.signature,
      parameters: extractParameters(parsed.fragment, parsed.args),
    };
  } catch {
    return null;
  }
}

type FourByteResponse = {
  count: number;
  results: Array<{ text_signature: string }>;
};

/**
 * Fetch known function signatures from 4byte.directory by selector
 */
async function fetch4byteSignatures(selector: string): Promise<string[]> {
  try {
    const response = await safeFetch(
      `${FOURBYTE_API_URL}?hex_signature=${selector}&ordering=created_at`,
      { plugin: "web3" }
    );
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as FourByteResponse;
    return data.results.map((r) => r.text_signature);
  } catch {
    return [];
  }
}

/**
 * Try each 4byte.directory signature until one decodes successfully
 */
function tryDecodeWith4byte(
  calldata: string,
  signatures: string[]
): {
  functionName: string;
  functionSignature: string;
  parameters: DecodedParameter[];
} | null {
  for (const sig of signatures) {
    try {
      const iface = new ethers.Interface([`function ${sig}`]);
      const parsed = iface.parseTransaction({ data: calldata });
      if (parsed) {
        return {
          functionName: parsed.name,
          functionSignature: parsed.signature,
          parameters: extractParameters(parsed.fragment, parsed.args),
        };
      }
    } catch {
      // Signature didn't match calldata encoding, try next
    }
  }
  return null;
}

/**
 * Fetch ABI from block explorer (Etherscan, Blockscout) for a verified contract
 */
async function fetchAbiFromExplorer(
  contractAddress: string,
  network: string
): Promise<ethers.InterfaceAbi | null> {
  try {
    const chainId = getChainIdFromNetwork(network);
    const explorerConfig = await db.query.explorerConfigs.findFirst({
      where: eq(explorerConfigs.chainId, chainId),
    });

    if (!explorerConfig) {
      return null;
    }

    const result = await fetchContractAbi(
      explorerConfig,
      contractAddress,
      chainId,
      ETHERSCAN_API_KEY || undefined
    );

    if (result.success && result.abi) {
      return result.abi as ethers.InterfaceAbi;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Validate and normalize raw calldata hex string.
 */
function validateCalldata(
  calldata: string
): { normalized: string } | DecodeCalldataResult {
  if (!calldata || typeof calldata !== "string") {
    return { success: false, error: "Calldata is required" };
  }

  const normalized = calldata.startsWith("0x") ? calldata : `0x${calldata}`;

  if (!HEX_PATTERN.test(normalized)) {
    return { success: false, error: "Calldata must be a valid hex string" };
  }

  return { normalized };
}

/**
 * Try decoding with a user-provided ABI JSON string
 */
function tryManualAbi(
  normalized: string,
  selector: string,
  abi: string
): DecodeCalldataResult | null {
  try {
    const parsedAbi = JSON.parse(abi) as ethers.InterfaceAbi;
    const decoded = tryDecodeWithAbi(normalized, parsedAbi);
    if (decoded) {
      return {
        success: true,
        selector,
        ...decoded,
        decodingSource: "manual-abi",
      };
    }
  } catch {
    // Invalid ABI JSON, fall through
  }
  return null;
}

/**
 * Try decoding via block explorer ABI lookup
 */
async function tryExplorerStrategy(
  normalized: string,
  selector: string,
  contractAddress: string,
  network: string
): Promise<DecodeCalldataResult | null> {
  if (!ethers.isAddress(contractAddress)) {
    return {
      success: false,
      error: `Invalid contract address: ${contractAddress}`,
    };
  }

  const explorerAbi = await fetchAbiFromExplorer(contractAddress, network);
  if (!explorerAbi) {
    return null;
  }

  const decoded = tryDecodeWithAbi(normalized, explorerAbi);
  if (decoded) {
    return { success: true, selector, ...decoded, decodingSource: "explorer" };
  }
  return null;
}

/**
 * Try decoding via 4byte.directory signature lookup
 */
async function try4byteStrategy(
  normalized: string,
  selector: string
): Promise<DecodeCalldataResult | null> {
  const signatures = await fetch4byteSignatures(selector);
  if (signatures.length === 0) {
    return null;
  }

  const decoded = tryDecodeWith4byte(normalized, signatures);
  if (decoded) {
    return { success: true, selector, ...decoded, decodingSource: "4byte" };
  }

  const firstSig = signatures[0];
  const funcName = firstSig.split("(")[0];
  return {
    success: true,
    selector,
    functionName: funcName,
    functionSignature: firstSig,
    parameters: [],
    decodingSource: "4byte-partial",
  };
}

/**
 * Core decode calldata logic
 *
 * Decoding strategy (in order):
 * 1. Manual ABI override (if provided)
 * 2. Explorer ABI lookup via Etherscan/Blockscout (if contract address + network provided)
 * 3. 4byte.directory signature database (fallback)
 * 4. Selector-only result (if all else fails)
 */
export async function decodeCalldata(
  input: DecodeCalldataCoreInput
): Promise<DecodeCalldataResult> {
  const { calldata, contractAddress, network, abi } = input;

  const validation = validateCalldata(calldata);
  if (!("normalized" in validation)) {
    return validation;
  }
  const { normalized } = validation;

  if (normalized === "0x") {
    return {
      success: true,
      selector: "0x",
      functionName: null,
      functionSignature: null,
      parameters: [],
      decodingSource: "none",
    };
  }

  if (normalized.length < 10) {
    return {
      success: false,
      error:
        "Calldata must contain at least a 4-byte function selector (10 hex characters including 0x prefix)",
    };
  }

  const selector = normalized.slice(0, 10).toLowerCase();

  if (abi?.trim()) {
    const result = tryManualAbi(normalized, selector, abi);
    if (result) {
      return result;
    }
  }

  if (contractAddress?.trim() && network?.trim()) {
    const result = await tryExplorerStrategy(
      normalized,
      selector,
      contractAddress,
      network
    );
    if (result) {
      return result;
    }
  }

  const fourByteResult = await try4byteStrategy(normalized, selector);
  if (fourByteResult) {
    return fourByteResult;
  }

  return {
    success: true,
    selector,
    functionName: null,
    functionSignature: null,
    parameters: [],
    decodingSource: "selector-only",
  };
}
