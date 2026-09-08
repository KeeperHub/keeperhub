/**
 * Action Output Fields
 * Defines dynamic output fields for plugin actions based on their configuration
 */

import { findAbiFunction } from "@/lib/abi/utils";
import type { OutputField } from "@/plugins/registry";

type AbiParam = { name?: string; type?: string; components?: AbiParam[] };

// Cap how deep we expand nested tuple field paths in autocomplete to keep the
// suggestion list bounded for deeply nested structs.
const MAX_OUTPUT_FIELD_DEPTH = 4;

function isTupleParam(
  param: AbiParam
): param is AbiParam & { components: AbiParam[] } {
  return (
    (param.type ?? "").startsWith("tuple") && Array.isArray(param.components)
  );
}

// Append a dotted field path for each component of a tuple param, recursing
// into nested tuples. tuple[] elements are not individually addressable here,
// so expansion stops at the array field itself. Mirrors structureAbiOutputs.
function appendTupleComponentPaths(
  fields: OutputField[],
  basePath: string,
  param: AbiParam,
  depth: number
): void {
  if (depth >= MAX_OUTPUT_FIELD_DEPTH || !isTupleParam(param)) {
    return;
  }
  if ((param.type ?? "").endsWith("]")) {
    return;
  }
  for (const [index, component] of param.components.entries()) {
    const key = component.name?.trim() || `unnamedOutput${index}`;
    const path = `${basePath}.${key}`;
    fields.push({
      field: path,
      description: `Return value: ${component.type} (${getDeserializedType(component.type ?? "")})`,
    });
    appendTupleComponentPaths(fields, path, component, depth + 1);
  }
}

/**
 * Get output fields for Read Contract action based on ABI and selected function
 */
export function getReadContractOutputFields(
  abi: string | undefined,
  functionName: string | undefined
): OutputField[] {
  // Default Read Contract output fields when ABI/function not configured
  const defaultFields: OutputField[] = [
    { field: "success", description: "Whether the contract call succeeded" },
    { field: "result", description: "The contract function return value" },
    { field: "addressLink", description: "Explorer link to the contract" },
    { field: "error", description: "Error message if the call failed" },
  ];

  if (!(abi && functionName)) {
    return defaultFields;
  }

  try {
    const abiArray = JSON.parse(abi);
    if (!Array.isArray(abiArray)) {
      return defaultFields;
    }

    const functionAbi = findAbiFunction(abiArray, functionName);

    if (!functionAbi?.outputs) {
      return defaultFields;
    }

    const outputs = functionAbi.outputs as AbiParam[];

    // Build output fields based on function outputs
    const outputFields: OutputField[] = [
      { field: "success", description: "Whether the contract call succeeded" },
      { field: "result", description: "The contract function return value" },
    ];

    if (outputs.length === 1) {
      // Single output
      const output = outputs[0];
      const outputName = output.name?.trim();
      if (outputName) {
        // Named single output: result is an object with this field
        outputFields.push({
          field: `result.${outputName}`,
          description: `Return value: ${output.type} (${getDeserializedType(output.type ?? "")})`,
        });
        appendTupleComponentPaths(
          outputFields,
          `result.${outputName}`,
          output,
          1
        );
      } else {
        // Unnamed single output: a tuple's components surface directly under
        // result; a scalar is just `result` (already added).
        appendTupleComponentPaths(outputFields, "result", output, 0);
      }
    } else if (outputs.length > 1) {
      // Multiple outputs: result is an object with named fields
      for (const [index, output] of outputs.entries()) {
        const fieldName = output.name?.trim() || `unnamedOutput${index}`;
        const path = `result.${fieldName}`;
        outputFields.push({
          field: path,
          description: `Return value: ${output.type} (${getDeserializedType(output.type ?? "")})`,
        });
        appendTupleComponentPaths(outputFields, path, output, 1);
      }
    }

    // Add standard fields
    outputFields.push(
      { field: "addressLink", description: "Explorer link to the contract" },
      { field: "error", description: "Error message if the call failed" }
    );

    return outputFields;
  } catch {
    // If ABI parsing fails, return default fields
    return defaultFields;
  }
}

/**
 * Get the deserialized JavaScript type for a Solidity type
 */
function getDeserializedType(solidityType: string): string {
  if (solidityType.includes("uint") || solidityType.includes("int")) {
    return "BigInt";
  }
  if (solidityType === "bool") {
    return "boolean";
  }
  return "string";
}
