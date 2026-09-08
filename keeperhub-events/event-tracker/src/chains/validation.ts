import { ethers } from "ethers";
import { logger } from "../../lib/utils/logger";

export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

export interface AbiInput {
  name: string;
  type: string;
  indexed?: boolean;
  components?: AbiInput[];
}

export interface AbiEvent {
  name: string;
  type: string;
  inputs: AbiInput[];
}

export async function validateContractAddress(
  address: string,
  rpcUrl: string,
): Promise<ValidationResult> {
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const code = await provider.getCode(address);

    if (!code || code === "0x" || code === "0x0") {
      return {
        isValid: false,
        error: `Address ${address} is not a contract on this network (no bytecode found)`,
      };
    }

    return { isValid: true };
  } catch (error: any) {
    return {
      isValid: false,
      error: `Failed to validate contract address: ${error.message}`,
    };
  }
}

export function validateAbiHasEvent(
  abi: any[],
  eventName: string,
): ValidationResult {
  if (!Array.isArray(abi)) {
    return {
      isValid: false,
      error: "ABI is not a valid array",
    };
  }

  const events = abi.filter((item: any) => item.type === "event");

  if (events.length === 0) {
    return {
      isValid: false,
      error: "ABI does not contain any events",
    };
  }

  const hasEvent = events.some((event: any) => event.name === eventName);

  if (!hasEvent) {
    const availableEvents = events.map((e: any) => e.name).join(", ");
    return {
      isValid: false,
      error: `Event '${eventName}' not found in ABI. Available events: ${availableEvents}`,
    };
  }

  return { isValid: true };
}

export async function validateContractImplementsEvent(
  address: string,
  rpcUrl: string,
  abi: any[],
  eventName: string,
): Promise<ValidationResult> {
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(address, abi, provider);

    const eventFragment = contract.interface.getEvent(eventName);

    if (!eventFragment) {
      return {
        isValid: false,
        error: `Event '${eventName}' not found in contract interface`,
      };
    }

    const eventTopic = eventFragment.topicHash;
    logger.log(`[Validation] Event '${eventName}' topic hash: ${eventTopic}`);

    return { isValid: true };
  } catch (error: any) {
    return {
      isValid: false,
      error: `Failed to validate contract implements event: ${error.message}`,
    };
  }
}
