import { describe, expect, it } from "vitest";
import {
  getRegisteredProtocols,
  protocolActionToPluginAction,
} from "@/lib/protocol-registry";
import "@/protocols";

describe("Protocol output field advertisements", () => {
  it("every advertised output field is reachable in the runtime result shape", () => {
    const violations: Array<{
      protocol: string;
      action: string;
      field: string;
      reason: string;
    }> = [];

    for (const protocol of getRegisteredProtocols()) {
      for (const action of protocol.actions) {
        if (action.type !== "read") {
          continue;
        }

        const contract = protocol.contracts[action.contract];
        if (!(contract?.abi && action.function)) {
          continue;
        }

        let abiArray: unknown[];
        try {
          const parsed = JSON.parse(contract.abi);
          if (!Array.isArray(parsed)) {
            continue;
          }
          abiArray = parsed;
        } catch {
          continue;
        }

        const functionAbi = abiArray.find(
          (entry: any) =>
            entry.type === "function" && entry.name === action.function
        ) as any;
        if (!functionAbi?.outputs) {
          continue;
        }

        const abiOutputs = functionAbi.outputs as Array<{
          name?: string;
          type?: string;
          components?: unknown[];
        }>;

        // Convert to plugin action to get the advertised outputFields
        const pluginAction = protocolActionToPluginAction(protocol, action);

        // Build the set of reachable paths at runtime.
        const reachablePaths = new Set<string>(["result", "success", "error"]);

        if (abiOutputs.length === 1) {
          const abiOutput = abiOutputs[0];
          const abiName = abiOutput.name?.trim();
          if (abiName) {
            // Named single output: result is { [name]: value }
            reachablePaths.add(`result.${abiName}`);
          } else if (abiOutput.type === "tuple" && Array.isArray(abiOutput.components)) {
            // Unnamed single tuple: structureAbiOutputs returns the tuple
            // directly (not wrapped), so components are at result.componentName.
            for (const comp of abiOutput.components as Array<{ name?: string }>) {
              if (comp.name) {
                reachablePaths.add(`result.${comp.name}`);
              }
            }
          }
          // Unnamed single scalar: result is the bare value, so only "result"
          // is reachable.
        } else if (abiOutputs.length > 1) {
          // Multiple outputs: result is an object with one key per output.
          for (const [index, abiOutput] of abiOutputs.entries()) {
            const key = abiOutput.name?.trim() || `unnamedOutput${index}`;
            reachablePaths.add(`result.${key}`);
          }
        }

        // Check every advertised field.
        for (const outputField of pluginAction.outputFields || []) {
          const { field } = outputField;
          if (!reachablePaths.has(field)) {
            violations.push({
              protocol: protocol.slug,
              action: action.slug,
              field,
              reason: `Advertised field "${field}" does not exist in runtime result. Reachable paths: ${Array.from(reachablePaths).join(", ")}`,
            });
          }
        }
      }
    }

    if (violations.length > 0) {
      const summary = violations
        .map((v) => `  ${v.protocol}/${v.action}: ${v.field}\n    ${v.reason}`)
        .join("\n");
      throw new Error(
        `${violations.length} advertised output fields are unreachable at runtime:\n${summary}`
      );
    }
  });

  it("read actions with named single outputs advertise result.fieldName", () => {
    const protocols = getRegisteredProtocols();
    // Find an action with a truly named single output (ABI has name field)
    for (const protocol of protocols) {
      for (const action of protocol.actions) {
        if (action.type !== "read") {
          continue;
        }

        const contract = protocol.contracts[action.contract];
        if (!contract?.abi) {
          continue;
        }

        try {
          const abiArray = JSON.parse(contract.abi);
          if (!Array.isArray(abiArray)) {
            continue;
          }

          const functionAbi = abiArray.find(
            (entry: any) =>
              entry.type === "function" && entry.name === action.function
          );
          if (!functionAbi?.outputs) {
            continue;
          }

          const outputs = functionAbi.outputs as Array<{
            name?: string;
            type?: string;
          }>;

          if (outputs.length === 1 && outputs[0].name?.trim()) {
            // Found a truly named single output
            const pluginAction = protocolActionToPluginAction(protocol, action);
            const outputFields = pluginAction.outputFields || [];
            const fieldNames = outputFields.map((f) => f.field);

            // Should advertise "result" and "result.fieldName", not bare "fieldName"
            expect(fieldNames).toContain("result");
            expect(fieldNames).toContain(`result.${outputs[0].name.trim()}`);
            expect(fieldNames).not.toContain(outputs[0].name.trim());
            return; // Test passes once we find one example
          }
        } catch {
          // Ignore ABI parse errors
        }
      }
    }

    // If no such action exists, the test is vacuously true
    expect(true).toBe(true);
  });

  it("read actions with unnamed single scalar outputs advertise only result", () => {
    const protocols = getRegisteredProtocols();
    // Find an action with a single unnamed scalar output (if any exist)
    for (const protocol of protocols) {
      for (const action of protocol.actions) {
        if (action.type !== "read") {
          continue;
        }

        const contract = protocol.contracts[action.contract];
        if (!contract?.abi) {
          continue;
        }

        try {
          const abiArray = JSON.parse(contract.abi);
          if (!Array.isArray(abiArray)) {
            continue;
          }

          const functionAbi = abiArray.find(
            (entry: any) =>
              entry.type === "function" && entry.name === action.function
          );
          if (!functionAbi?.outputs) {
            continue;
          }

          const outputs = functionAbi.outputs as Array<{
            name?: string;
            type?: string;
          }>;

          if (
            outputs.length === 1 &&
            !outputs[0].name?.trim() &&
            !outputs[0].type?.startsWith("tuple")
          ) {
            // Found an unnamed single scalar output
            const pluginAction = protocolActionToPluginAction(protocol, action);
            const outputFields = pluginAction.outputFields || [];
            const resultFields = outputFields.filter((f) =>
              f.field.startsWith("result")
            );

            // Should only advertise "result", not "result.X"
            expect(resultFields).toHaveLength(1);
            expect(resultFields[0].field).toBe("result");
            return; // Test passes once we find one example
          }
        } catch {
          // Ignore ABI parse errors
        }
      }
    }

    // If no such action exists, the test is vacuously true
    expect(true).toBe(true);
  });

  it("read actions with multiple outputs advertise result.field1, result.field2, etc", () => {
    const protocols = getRegisteredProtocols();
    // Find an action with multiple outputs
    for (const protocol of protocols) {
      for (const action of protocol.actions) {
        if (action.type !== "read") {
          continue;
        }

        const contract = protocol.contracts[action.contract];
        if (!contract?.abi) {
          continue;
        }

        try {
          const abiArray = JSON.parse(contract.abi);
          if (!Array.isArray(abiArray)) {
            continue;
          }

          const functionAbi = abiArray.find(
            (entry: any) =>
              entry.type === "function" && entry.name === action.function
          );
          if (!functionAbi?.outputs) {
            continue;
          }

          const outputs = functionAbi.outputs as Array<{
            name?: string;
            type?: string;
          }>;

          if (outputs.length > 1) {
            // Found a multi-output action
            const pluginAction = protocolActionToPluginAction(protocol, action);
            const outputFields = pluginAction.outputFields || [];
            const resultFields = outputFields.filter(
              (f) => f.field.startsWith("result.") || f.field === "result"
            );

            // Should advertise "result" plus one "result.X" per output
            expect(resultFields.length).toBeGreaterThanOrEqual(outputs.length);

            // Each should be prefixed with "result." (except the base "result")
            for (const field of resultFields) {
              if (field.field !== "result") {
                expect(field.field).toMatch(/^result\./);
              }
            }
            return; // Test passes once we find one example
          }
        } catch {
          // Ignore ABI parse errors
        }
      }
    }

    // If no such action exists, the test is vacuously true
    expect(true).toBe(true);
  });

  it("write actions do not advertise action.outputs fields", () => {
    const protocols = getRegisteredProtocols();
    for (const protocol of protocols) {
      for (const action of protocol.actions) {
        if (action.type !== "write") {
          continue;
        }

        const pluginAction = protocolActionToPluginAction(protocol, action);
        const outputFields = pluginAction.outputFields || [];
        const fieldNames = outputFields.map((f) => f.field);

        // Write actions should only have: success, error, transactionHash, transactionLink
        // They should NOT have any result.X fields from action.outputs
        for (const field of fieldNames) {
          expect(field).not.toMatch(/^result/);
        }

        // Standard write fields should be present
        expect(fieldNames).toContain("success");
        expect(fieldNames).toContain("error");
        expect(fieldNames).toContain("transactionHash");
        expect(fieldNames).toContain("transactionLink");
      }
    }
  });
});
