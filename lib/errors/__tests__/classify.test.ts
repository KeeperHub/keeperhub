import { describe, expect, it } from "vitest";
import { classifyExecutionError } from "@/lib/errors/classify";
import { ErrorCategory } from "@/lib/logging";

describe("classifyExecutionError", () => {
  describe("empty / null / unknown inputs default to system workflow_engine", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty string", ""],
      ["whitespace only", "   \n\t  "],
      [
        "totally unmatched message",
        "something completely novel that no rule matches",
      ],
    ])("returns workflow_engine + system for %s", (_label, input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.WORKFLOW_ENGINE);
      expect(r.errorType).toBe("system");
    });
  });

  describe("user-config: template and variable failures", () => {
    it.each([
      "Unresolved template reference(s): {{@nodeId:Foo.bar}} (Reference left in render)",
      "Missing template variable(s) in URL: address",
      "HTTP request failed: Missing template variable(s) in URL: address",
    ])("classifies %s as configuration + user", (input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.CONFIGURATION);
      expect(r.errorType).toBe("user");
    });
  });

  describe("user-config: safe-fetch validation", () => {
    it.each([
      "safe-fetch: invalid URL",
      "safe-fetch: scheme file: not allowed",
      "blocked by SSRF policy",
      "URL is required",
    ])("classifies %s as validation + user", (input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.VALIDATION);
      expect(r.errorType).toBe("user");
    });
  });

  describe("user-config: workflow authoring mistakes", () => {
    it("Code execution failed: validation + user", () => {
      const r = classifyExecutionError(
        "Code execution failed: require is not defined"
      );
      expect(r.errorCategory).toBe(ErrorCategory.VALIDATION);
      expect(r.errorType).toBe("user");
    });

    it("Invalid contract address: validation + user", () => {
      const r = classifyExecutionError("Invalid contract address: ");
      expect(r.errorCategory).toBe(ErrorCategory.VALIDATION);
      expect(r.errorType).toBe("user");
    });

    it("Invalid function arguments: validation + user", () => {
      const r = classifyExecutionError(
        "Invalid function arguments: _fee.nativeFee: uint256 cannot be empty"
      );
      expect(r.errorCategory).toBe(ErrorCategory.VALIDATION);
      expect(r.errorType).toBe("user");
    });

    it("For Each: arraySource is required: configuration + user", () => {
      const r = classifyExecutionError(
        "For Each: arraySource is required. Configure a template reference to an array"
      );
      expect(r.errorCategory).toBe(ErrorCategory.CONFIGURATION);
      expect(r.errorType).toBe("user");
    });

    it("Condition references field: configuration + user", () => {
      const r = classifyExecutionError(
        'Condition references field "logs" but "logs" does not exist on the data'
      );
      expect(r.errorCategory).toBe(ErrorCategory.CONFIGURATION);
      expect(r.errorType).toBe("user");
    });

    it("No token selected: configuration + user", () => {
      const r = classifyExecutionError("No token selected to check");
      expect(r.errorCategory).toBe(ErrorCategory.CONFIGURATION);
      expect(r.errorType).toBe("user");
    });

    it("Contract call failed: transaction + user", () => {
      const r = classifyExecutionError(
        "Contract call failed: Error(This spell has already been scheduled)"
      );
      expect(r.errorCategory).toBe(ErrorCategory.TRANSACTION);
      expect(r.errorType).toBe("user");
    });
  });

  describe("network / RPC: external dependencies", () => {
    it("RPC failed on both endpoints: network_rpc + system", () => {
      const r = classifyExecutionError(
        "RPC failed on both endpoints. Primary: request timeout. Fallback: request timeout"
      );
      expect(r.errorCategory).toBe(ErrorCategory.NETWORK_RPC);
      expect(r.errorType).toBe("system");
    });

    it("Failed to check balance: RPC failed: network_rpc + system", () => {
      const r = classifyExecutionError(
        "Failed to check balance: RPC failed on both endpoints. Primary: request timeout"
      );
      expect(r.errorCategory).toBe(ErrorCategory.NETWORK_RPC);
      expect(r.errorType).toBe("system");
    });

    it("Failed to send webhook DNS failure: external_service + user (likely bad URL)", () => {
      const r = classifyExecutionError(
        "Failed to send webhook: fetch failed: getaddrinfo EAI_AGAIN events.pagerduty.com"
      );
      expect(r.errorCategory).toBe(ErrorCategory.EXTERNAL_SERVICE);
      expect(r.errorType).toBe("user");
    });
  });

  describe("system: database / persistence", () => {
    it.each([
      "Database query failed: Database connection failed. Please verify your connection settings.",
      'Failed query: update "workflow_executions" set "status" = $1 where "workflow_executions"."id" = $2',
      "getaddrinfo EAI_AGAIN keeperhub-prod.cwmewmwvrqii.us-east-2.rds.amazonaws.com",
    ])("classifies %s as database + system", (input) => {
      const r = classifyExecutionError(input);
      expect(r.errorCategory).toBe(ErrorCategory.DATABASE);
      expect(r.errorType).toBe("system");
    });
  });

  describe("system: workflow engine internals", () => {
    it("Execution timed out: workflow_engine + system", () => {
      const r = classifyExecutionError(
        "Execution timed out: no progress for 30 minutes"
      );
      expect(r.errorCategory).toBe(ErrorCategory.WORKFLOW_ENGINE);
      expect(r.errorType).toBe("system");
    });

    it("Step exceeded max retries: workflow_engine + system", () => {
      const r = classifyExecutionError(
        'Step "step//./plugins/web3/steps/read-contract//readContractStep" exceeded max retries (1 retry)'
      );
      expect(r.errorCategory).toBe(ErrorCategory.WORKFLOW_ENGINE);
      expect(r.errorType).toBe("system");
    });

    it("Unknown action type: workflow_engine + system", () => {
      const r = classifyExecutionError(
        'Unknown action type: "condition". This action is not registered in the plugin system.'
      );
      expect(r.errorCategory).toBe(ErrorCategory.WORKFLOW_ENGINE);
      expect(r.errorType).toBe("system");
    });

    it("Failed to acquire nonce lock: workflow_engine + system", () => {
      const r = classifyExecutionError(
        "Failed to acquire nonce lock for 0xae36bc35098e24bbaed3dee86ec4653eb88a71a9:1 after 50 attempts"
      );
      expect(r.errorCategory).toBe(ErrorCategory.WORKFLOW_ENGINE);
      expect(r.errorType).toBe("system");
    });
  });

  describe("system: infra / deploy / secrets", () => {
    it("Workflow terminated by SIGTERM: infrastructure + system", () => {
      const r = classifyExecutionError("Workflow terminated by SIGTERM signal");
      expect(r.errorCategory).toBe(ErrorCategory.INFRASTRUCTURE);
      expect(r.errorType).toBe("system");
    });

    it("Cannot find module: infrastructure + system", () => {
      const r = classifyExecutionError(
        "Cannot find module './credential-map'\nRequire stack:\n- /app/lib/credential-fetcher.ts"
      );
      expect(r.errorCategory).toBe(ErrorCategory.INFRASTRUCTURE);
      expect(r.errorType).toBe("system");
    });

    it("Failed to initialize organization wallet (missing Turnkey key): infrastructure + system", () => {
      const r = classifyExecutionError(
        "Failed to initialize organization wallet: TURNKEY_API_PUBLIC_KEY and TURNKEY_API_PRIVATE_KEY must be set"
      );
      expect(r.errorCategory).toBe(ErrorCategory.INFRASTRUCTURE);
      expect(r.errorType).toBe("system");
    });
  });

  describe("ErrorCategory enum exhaustiveness", () => {
    it("returns values that all belong to the ErrorCategory enum", () => {
      const allCategoryValues = new Set(Object.values(ErrorCategory));
      const samples = [
        "Unresolved template reference foo",
        "Database query failed: x",
        "Execution timed out",
        "Contract call failed: x",
        "Code execution failed: x",
        "Cannot find module foo",
        "RPC failed on both endpoints: x",
        "Failed to send webhook: x",
        "Workflow terminated by SIGTERM",
        "novel unmatched error",
      ];
      for (const s of samples) {
        const r = classifyExecutionError(s);
        expect(allCategoryValues.has(r.errorCategory)).toBe(true);
        expect(r.errorType === "user" || r.errorType === "system").toBe(true);
      }
    });
  });
});
