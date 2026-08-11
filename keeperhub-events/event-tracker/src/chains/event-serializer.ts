import type { ethers } from "ethers";
import type { AbiEvent, AbiInput } from "./validation";

export type SerializedValue =
  | string
  | SerializedValue[]
  | { [key: string]: SerializedArg };

export interface SerializedArg {
  value: SerializedValue;
  type: string;
}

export interface EventPayload {
  eventName: string;
  args: Record<string, SerializedArg>;
  blockNumber: SerializedArg;
  transactionHash: string;
  blockHash: string;
  address: string;
  logIndex: SerializedArg;
  transactionIndex: SerializedArg;
}

const FIXED_ARRAY_PATTERN = /^(.+)\[(\d+)\]$/;

export function convertBigIntToString(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => convertBigIntToString(item));
  }
  if (value && typeof value === "object") {
    const converted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      converted[key] = convertBigIntToString(val);
    }
    return converted;
  }
  return value;
}

export function serializePrimitive(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    return value.toString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value.toString();
  }
  if (value && typeof value === "object") {
    const maybeStringifiable = value as { toString?: () => string };
    if (typeof maybeStringifiable.toString === "function") {
      return maybeStringifiable.toString();
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function serializeArg(
  value: unknown,
  type: string,
  components: AbiInput[] | null,
): SerializedArg {
  if (type.endsWith("[]")) {
    const baseType = type.slice(0, -2);
    if (Array.isArray(value)) {
      return {
        value: value.map((item) => serializeArg(item, baseType, null).value),
        type,
      };
    }
    return {
      value: serializePrimitive(value),
      type,
    };
  }

  const fixedArrayMatch = type.match(FIXED_ARRAY_PATTERN);
  if (fixedArrayMatch) {
    const baseType = fixedArrayMatch[1];
    if (Array.isArray(value)) {
      return {
        value: value.map((item) => serializeArg(item, baseType, null).value),
        type,
      };
    }
    return {
      value: serializePrimitive(value),
      type,
    };
  }

  if (type === "tuple" && components && Array.isArray(components)) {
    if (Array.isArray(value)) {
      const tupleValue: Record<string, SerializedArg> = {};
      components.forEach((component, index) => {
        const fieldName = component.name || `field${index}`;
        tupleValue[fieldName] = serializeArg(
          value[index],
          component.type,
          component.components || null,
        );
      });
      return {
        value: tupleValue,
        type,
      };
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const tupleValue: Record<string, SerializedArg> = {};
      components.forEach((component, index) => {
        const fieldName = component.name || `field${index}`;
        let fieldValue: unknown;
        if (obj[fieldName] !== undefined) {
          fieldValue = obj[fieldName];
        } else if (Array.isArray(value)) {
          fieldValue = value[index];
        } else {
          fieldValue = Object.values(value)[index];
        }
        tupleValue[fieldName] = serializeArg(
          fieldValue,
          component.type,
          component.components || null,
        );
      });
      return {
        value: tupleValue,
        type,
      };
    }
  }

  return {
    value: serializePrimitive(value),
    type,
  };
}

export function extractEventArgs(
  parsedLog: ethers.LogDescription,
  rawEventsAbi: AbiEvent[],
): Record<string, SerializedArg> {
  const args: Record<string, SerializedArg> = {};
  const eventAbi = rawEventsAbi.find((event) => event.name === parsedLog.name);

  if (eventAbi?.inputs) {
    eventAbi.inputs.forEach((input, index) => {
      const argValue: unknown = parsedLog.args[index];
      const argName = input.name || `arg${index}`;

      args[argName] = serializeArg(
        argValue,
        input.type,
        input.components || null,
      );
    });
  } else {
    parsedLog.args.forEach((arg: unknown, index: number) => {
      args[`arg${index}`] = serializeArg(arg, "unknown", null);
    });
  }
  return args;
}

export function buildEventPayload(
  log: ethers.Log,
  parsedLog: ethers.LogDescription,
  args: Record<string, SerializedArg>,
): EventPayload {
  return {
    eventName: parsedLog.name,
    args,
    blockNumber: {
      value: serializePrimitive(log.blockNumber),
      type: "uint256",
    },
    transactionHash: log.transactionHash,
    blockHash: log.blockHash,
    address: log.address,
    logIndex: {
      value: serializePrimitive(log.index),
      type: "uint256",
    },
    transactionIndex: {
      value: serializePrimitive(log.transactionIndex),
      type: "uint256",
    },
  };
}

export function buildEventAbi(eventType: AbiEvent): string {
  const { name, inputs } = eventType;

  const parsedInputs = inputs
    .map(
      ({ name: inputName, type, indexed }) =>
        `${type} ${indexed ? "indexed " : ""}${inputName}`,
    )
    .join(", ");

  return `event ${name}(${parsedInputs})`;
}
