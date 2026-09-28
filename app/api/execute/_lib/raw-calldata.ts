import { ethers } from "ethers";

const HEX_PATTERN = /^0x[\da-fA-F]*$/;
const SELECTOR_HEX_LENGTH = 10; // "0x" + 4 bytes

export type RawCalldataResolution = {
  /** Full signature, e.g. `approve(address,uint256)`, so overloads bind unambiguously. */
  functionName: string;
  functionArgs: string;
  selector: string;
};

export type RawCalldataError = { error: string };

// The same test the schema uses; it has already refused `data` next to a
// function key, so presence alone decides the path.
export function isRawCalldataRequest(body: Record<string, unknown>): boolean {
  return "data" in body;
}

export function selectorOf(data: string): string | RawCalldataError {
  if (typeof data !== "string" || !HEX_PATTERN.test(data)) {
    return { error: "data must be a 0x-prefixed hex string" };
  }
  if (data.length < SELECTOR_HEX_LENGTH || data.length % 2 !== 0) {
    return {
      error:
        "data must be whole bytes carrying at least a 4-byte function selector; a plain value transfer belongs on /api/execute/transfer",
    };
  }
  return data.slice(0, SELECTOR_HEX_LENGTH).toLowerCase();
}

export function resolveRawCalldata(
  data: string,
  abi: string
): RawCalldataResolution | RawCalldataError {
  const selector = selectorOf(data);
  if (typeof selector !== "string") {
    return selector;
  }

  let iface: ethers.Interface;
  try {
    iface = new ethers.Interface(JSON.parse(abi) as ethers.InterfaceAbi);
  } catch {
    return { error: "Invalid ABI JSON" };
  }

  let parsed: ethers.TransactionDescription | null;
  try {
    parsed = iface.parseTransaction({ data });
  } catch (err: unknown) {
    return {
      error: `Calldata does not decode against the ABI: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed === null) {
    return {
      error: `Selector ${selector} is not in the ABI. Supply the contract's ABI in \`abi\`, or pass functionName and functionArgs instead of data.`,
    };
  }

  // We broadcast a transaction rebuilt from the decoded arguments, not these
  // bytes, so anything the decode drops never reaches the chain.
  let reencoded: string;
  try {
    reencoded = iface.encodeFunctionData(parsed.fragment, parsed.args);
  } catch (err: unknown) {
    return {
      error: `Calldata decoded but could not be re-encoded for comparison: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (reencoded.toLowerCase() !== data.toLowerCase()) {
    return {
      error:
        `data is not the canonical encoding of the call it decodes to: ${parsed.fragment.format("sighash")} re-encodes to ${reencoded}. ` +
        "The transaction is built from the decoded arguments, not from the bytes sent, so trailing bytes, non-minimal offsets and non-canonical padding are refused instead of being dropped silently.",
    };
  }

  const args = parsed.fragment.inputs.map((input, i) =>
    toJsonArg(parsed.args[i], input)
  );
  return {
    functionName: parsed.fragment.format("sighash"),
    functionArgs: JSON.stringify(args),
    selector,
  };
}

function toJsonArg(value: unknown, input: ethers.ParamType): unknown {
  if (input.baseType === "array") {
    const items = Array.from(value as Iterable<unknown>);
    const child = input.arrayChildren as ethers.ParamType;
    return items.map((item) => toJsonArg(item, child));
  }
  if (input.baseType === "tuple") {
    // coerceTuple wants a struct keyed by component name; a nested array here
    // would be read as flat arguments.
    const components = input.components ?? [];
    const items = Array.from(value as Iterable<unknown>);
    const struct: Record<string, unknown> = {};
    for (const [i, component] of components.entries()) {
      struct[component.name || `c${i}`] = toJsonArg(items[i], component);
    }
    return struct;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value;
  }
  return String(value);
}
