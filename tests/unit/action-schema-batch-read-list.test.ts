import { describe, expect, it } from "vitest";

import {
  buildActionSchemasResponse,
  transformPluginAction,
} from "@/lib/action-schemas/builder";
import { getAllIntegrations } from "@/plugins/registry";

function schemaFor(actionType: string) {
  for (const plugin of getAllIntegrations()) {
    for (const action of plugin.actions) {
      const schema = transformPluginAction(plugin, action);
      if (schema.actionType === actionType) {
        return schema;
      }
    }
  }
  throw new Error(`no action ${actionType}`);
}

describe("ActionSchema - Batch Read Contract list inputs", () => {
  const batchRead = schemaFor("web3/batch-read-contract");
  const fields = { ...batchRead.requiredFields, ...batchRead.optionalFields };

  it("describes the Calls From options", () => {
    expect(fields.callsFrom).toBe(
      'string ("rows" | "args-list" | "address-list") - Calls From'
    );
  });

  it("gives each list a shape an agent can follow", () => {
    expect(fields.argsFromList).toBe(
      'JSON array, or a string holding one (supports {{@nodeId:Label.field}} templates) - Argument Sets - {{@node1:Label.result}} or [["0xabc...", 5], ["0xdef...", 6]]'
    );
    expect(fields.contractAddresses).toBe(
      'JSON array, or a string holding one (supports {{@nodeId:Label.field}} templates) - Contract Addresses - {{@node1:Label.result}} or ["0xabc...", "0xdef..."]'
    );
    expect(fields.abiFetchAddress).toContain("Fetch ABI From");
    expect(fields.functionArgs).toBe(
      "string (JSON array of function arguments) - Function Arguments"
    );
  });

  it("describes the rows instead of a bare string", () => {
    expect(fields.argsList).toBe(
      'string (JSON array of argument arrays, one per call, in the function\'s parameter order, e.g. [["0xabc..."],["0xdef..."]]) - Args List'
    );
    expect(fields.calls).toContain('{"network":"1","contractAddress":"0x..."');
  });

  it("leaves network out of a write batch's calls, which are single-chain", () => {
    const batchWrite = schemaFor("web3/batch-write-contract");
    const calls =
      batchWrite.requiredFields.calls ?? batchWrite.optionalFields.calls;
    expect(calls).toContain('{"contractAddress":"0x..."');
    expect(calls).not.toContain('"network"');
  });

  it("explains the list modes in the tips", async () => {
    const response = await buildActionSchemasResponse({
      includeChains: false,
      endpointLabel: "test",
    });
    const tips = response.tips as string[];
    const tip = tips.find((line) =>
      line.startsWith("web3/batch-read-contract")
    );
    expect(tip).toContain(
      'argsFromList is required only for "args-list" and contractAddresses only for "address-list"'
    );
    expect(tip).toContain("contractAddress is not used");
    expect(tip).toContain(
      "abi is still required, and abiFetchAddress is only where the editor fetches it from and what workflow validation compares the ABI against"
    );
    expect(tip).toContain("a string holding one");
    expect(tip).toContain("up to 5,000 calls per run");
  });
});
