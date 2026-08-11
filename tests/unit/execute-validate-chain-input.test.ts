import { describe, expect, it } from "vitest";
import {
  validateCheckAndExecuteInput,
  validateContractCallInput,
  validateTransferInput,
} from "@/app/api/execute/_lib/validate";

describe("KEEP-490: execute validators accept chainId or network", () => {
  describe("validateTransferInput", () => {
    it("accepts chainId as canonical field", () => {
      const result = validateTransferInput({
        chainId: 11_155_111,
        recipientAddress: "0xabc",
        amount: "1",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts network as deprecated alias", () => {
      const result = validateTransferInput({
        network: "sepolia",
        recipientAddress: "0xabc",
        amount: "1",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects when both chainId and network are missing", () => {
      const result = validateTransferInput({
        recipientAddress: "0xabc",
        amount: "1",
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.field).toBe("chainId");
      }
    });

    it("accepts stringified chainId", () => {
      const result = validateTransferInput({
        chainId: "11155111",
        recipientAddress: "0xabc",
        amount: "1",
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("validateContractCallInput", () => {
    it("accepts chainId as canonical field", () => {
      const result = validateContractCallInput({
        chainId: 1,
        contractAddress: "0xabc",
        functionName: "balanceOf",
      });
      expect(result.valid).toBe(true);
    });

    it("accepts network alias", () => {
      const result = validateContractCallInput({
        network: "ethereum",
        contractAddress: "0xabc",
        functionName: "balanceOf",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects when both fields are missing", () => {
      const result = validateContractCallInput({
        contractAddress: "0xabc",
        functionName: "balanceOf",
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.field).toBe("chainId");
      }
    });
  });

  describe("validateCheckAndExecuteInput", () => {
    const baseValidExtras = {
      contractAddress: "0xabc",
      functionName: "deposit",
      condition: { operator: "lt", value: "1" },
      action: { contractAddress: "0xabc", functionName: "f" },
    };

    it("accepts chainId as canonical field", () => {
      const result = validateCheckAndExecuteInput({
        chainId: 8453,
        ...baseValidExtras,
      });
      expect(result.valid).toBe(true);
    });

    it("accepts network alias", () => {
      const result = validateCheckAndExecuteInput({
        network: "base",
        ...baseValidExtras,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects when both chain inputs are missing", () => {
      const result = validateCheckAndExecuteInput(baseValidExtras);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.field).toBe("chainId");
      }
    });
  });
});
