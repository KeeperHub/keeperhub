import { describe, expect, it } from "vitest";
import {
  solidityTypeToFieldType,
  validateAddress,
  validateBool,
  validateBytes,
  validateEthValue,
  validateInt,
  validateSolidityValue,
  validateUint,
} from "@/lib/solidity-type-fields";

describe("solidityTypeToFieldType", () => {
  it("maps address to protocol-address", () => {
    expect(solidityTypeToFieldType("address")).toBe("protocol-address");
  });

  it("maps uint types to protocol-uint", () => {
    expect(solidityTypeToFieldType("uint256")).toBe("protocol-uint");
    expect(solidityTypeToFieldType("uint8")).toBe("protocol-uint");
    expect(solidityTypeToFieldType("uint128")).toBe("protocol-uint");
  });

  it("maps int types to protocol-int", () => {
    expect(solidityTypeToFieldType("int256")).toBe("protocol-int");
    expect(solidityTypeToFieldType("int8")).toBe("protocol-int");
  });

  it("maps bool to protocol-bool", () => {
    expect(solidityTypeToFieldType("bool")).toBe("protocol-bool");
  });

  it("maps bytes types to protocol-bytes", () => {
    expect(solidityTypeToFieldType("bytes")).toBe("protocol-bytes");
    expect(solidityTypeToFieldType("bytes32")).toBe("protocol-bytes");
    expect(solidityTypeToFieldType("bytes4")).toBe("protocol-bytes");
  });

  it("maps string to template-input", () => {
    expect(solidityTypeToFieldType("string")).toBe("template-input");
  });

  it("falls back to template-input for unknown types", () => {
    expect(solidityTypeToFieldType("tuple")).toBe("template-input");
    expect(solidityTypeToFieldType("tuple[]")).toBe("template-input");
    expect(solidityTypeToFieldType("unknown")).toBe("template-input");
  });
});

describe("validateAddress", () => {
  it("accepts valid address", () => {
    expect(
      validateAddress("0x0000000000000000000000000000000000000001")
    ).toEqual({ valid: true });
  });

  it("rejects short address", () => {
    expect(validateAddress("0x0001").valid).toBe(false);
  });

  it("rejects non-hex", () => {
    expect(
      validateAddress("0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG").valid
    ).toBe(false);
  });

  it("rejects missing 0x prefix", () => {
    expect(
      validateAddress("0000000000000000000000000000000000000001").valid
    ).toBe(false);
  });
});

describe("validateUint", () => {
  it("accepts valid uint256", () => {
    expect(validateUint("1000000000000000000")).toEqual({ valid: true });
  });

  it("accepts zero", () => {
    expect(validateUint("0")).toEqual({ valid: true });
  });

  it("rejects negative", () => {
    expect(validateUint("-1").valid).toBe(false);
  });

  it("rejects non-numeric", () => {
    expect(validateUint("abc").valid).toBe(false);
  });

  it("rejects uint8 overflow", () => {
    expect(validateUint("256", 8).valid).toBe(false);
    expect(validateUint("255", 8)).toEqual({ valid: true });
  });

  it("accepts max uint256", () => {
    const max = ((BigInt(1) << BigInt(256)) - BigInt(1)).toString();
    expect(validateUint(max, 256)).toEqual({ valid: true });
  });

  it("rejects uint256 overflow", () => {
    const overflow = (BigInt(1) << BigInt(256)).toString();
    expect(validateUint(overflow, 256).valid).toBe(false);
  });
});

describe("validateInt", () => {
  it("accepts positive int", () => {
    expect(validateInt("100")).toEqual({ valid: true });
  });

  it("accepts negative int", () => {
    expect(validateInt("-100")).toEqual({ valid: true });
  });

  it("rejects int8 overflow", () => {
    expect(validateInt("128", 8).valid).toBe(false);
    expect(validateInt("127", 8)).toEqual({ valid: true });
    expect(validateInt("-128", 8)).toEqual({ valid: true });
    expect(validateInt("-129", 8).valid).toBe(false);
  });

  it("rejects non-numeric", () => {
    expect(validateInt("abc").valid).toBe(false);
  });
});

describe("validateBool", () => {
  it("accepts true and false", () => {
    expect(validateBool("true")).toEqual({ valid: true });
    expect(validateBool("false")).toEqual({ valid: true });
  });

  it("rejects other values", () => {
    expect(validateBool("1").valid).toBe(false);
    expect(validateBool("yes").valid).toBe(false);
  });
});

describe("validateBytes", () => {
  it("accepts valid hex", () => {
    expect(validateBytes("0x")).toEqual({ valid: true });
    expect(validateBytes("0xabcdef")).toEqual({ valid: true });
  });

  it("rejects missing 0x prefix", () => {
    expect(validateBytes("abcdef").valid).toBe(false);
  });

  it("rejects invalid hex chars", () => {
    expect(validateBytes("0xGG").valid).toBe(false);
  });

  it("validates exact byte length for bytesN", () => {
    expect(validateBytes(`0x${"00".repeat(32)}`, 32)).toEqual({ valid: true });
    expect(validateBytes("0x00", 32).valid).toBe(false);
  });

  it("accepts any length for unspecified bytes", () => {
    expect(validateBytes(`0x${"ff".repeat(100)}`)).toEqual({ valid: true });
  });
});

describe("validateEthValue", () => {
  it("accepts valid decimal ETH amounts", () => {
    expect(validateEthValue("0.1")).toEqual({ valid: true });
    expect(validateEthValue("1.5")).toEqual({ valid: true });
    expect(validateEthValue("100")).toEqual({ valid: true });
    expect(validateEthValue("0.001")).toEqual({ valid: true });
  });

  it("rejects alphabetic input", () => {
    expect(validateEthValue("abc").valid).toBe(false);
    expect(validateEthValue("1.0abc").valid).toBe(false);
  });

  it("rejects negative values", () => {
    const result = validateEthValue("-1.0");
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.message).toBe(
      "Must be a decimal number (e.g. 0.1)"
    );
  });

  it("rejects empty string", () => {
    expect(validateEthValue("").valid).toBe(false);
  });

  it("passes template variables through", () => {
    expect(validateEthValue("{{node.ethAmount}}")).toEqual({ valid: true });
  });
});

describe("validateSolidityValue", () => {
  it("always passes template variables", () => {
    expect(validateSolidityValue("uint256", "{{PriceCheck.roundId}}")).toEqual({
      valid: true,
    });
    expect(
      validateSolidityValue("address", "{{@node1:Wallet.address}}")
    ).toEqual({ valid: true });
  });

  it("returns invalid for empty strings", () => {
    expect(validateSolidityValue("uint256", "").valid).toBe(false);
  });

  it("dispatches to correct type validator", () => {
    expect(
      validateSolidityValue(
        "address",
        "0x0000000000000000000000000000000000000001"
      )
    ).toEqual({ valid: true });
    expect(validateSolidityValue("uint256", "1000")).toEqual({ valid: true });
    expect(validateSolidityValue("bool", "true")).toEqual({ valid: true });
    expect(validateSolidityValue("bytes32", `0x${"00".repeat(32)}`)).toEqual({
      valid: true,
    });
  });

  it("passes unknown types as valid", () => {
    expect(validateSolidityValue("tuple", "anything")).toEqual({
      valid: true,
    });
  });
});
