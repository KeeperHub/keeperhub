/**
 * #2430: the `errorAbis` request field on both direct-execution routes.
 *
 * The field is additive, so the cases that matter are: a body without it is
 * unchanged, a valid document is accepted, and a document that could not do
 * what the field says is refused at the boundary rather than accepted and
 * silently ignored.
 */

import { describe, expect, it } from "vitest";
import {
  validateCheckAndExecuteInput,
  validateContractCallInput,
} from "@/app/api/execute/_lib/validate";

const HOOK_ERRORS = JSON.stringify([
  {
    type: "error",
    name: "ReleaseBlocked",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "reason", type: "bytes32" },
    ],
  },
]);

const CONTRACT_CALL = {
  chainId: 8453,
  contractAddress: "0xabc",
  functionName: "complete",
};

const CHECK_AND_EXECUTE = {
  ...CONTRACT_CALL,
  condition: { operator: "lt", value: "1" },
  action: { contractAddress: "0xabc", functionName: "f" },
};

describe("errorAbis on the direct-execution routes", () => {
  it("leaves a body without the field valid", () => {
    expect(validateContractCallInput(CONTRACT_CALL).valid).toBe(true);
    expect(validateCheckAndExecuteInput(CHECK_AND_EXECUTE).valid).toBe(true);
  });

  it("accepts a document that declares an error", () => {
    expect(
      validateContractCallInput({ ...CONTRACT_CALL, errorAbis: [HOOK_ERRORS] })
        .valid
    ).toBe(true);
    expect(
      validateCheckAndExecuteInput({
        ...CHECK_AND_EXECUTE,
        errorAbis: [HOOK_ERRORS],
      }).valid
    ).toBe(true);
  });

  it("refuses a malformed document on both routes, naming the field", () => {
    const malformed = validateContractCallInput({
      ...CONTRACT_CALL,
      errorAbis: ["{not json"],
    });
    expect(malformed.valid).toBe(false);
    if (!malformed.valid) {
      expect(malformed.error.field).toBe("errorAbis");
      expect(malformed.error.details).toContain("errorAbis[0]");
    }

    const checkAndExecute = validateCheckAndExecuteInput({
      ...CHECK_AND_EXECUTE,
      errorAbis: ["{not json"],
    });
    expect(checkAndExecute.valid).toBe(false);
    if (!checkAndExecute.valid) {
      expect(checkAndExecute.error.field).toBe("errorAbis");
    }
  });

  it("refuses a field that is not an array", () => {
    const result = validateContractCallInput({
      ...CONTRACT_CALL,
      errorAbis: HOOK_ERRORS,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.field).toBe("errorAbis");
      expect(result.error.error).toBe("Invalid field type");
    }
  });

  it("keeps the required-field checks ahead of the new one", () => {
    // A body missing its contract address reports that, not the extra field.
    const result = validateContractCallInput({
      chainId: 8453,
      functionName: "complete",
      errorAbis: ["{not json"],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.field).toBe("contractAddress");
    }
  });
});
