/**
 * Unit tests for balance formatting with BigInt precision
 *
 * Tests the formatWeiToBalance function which handles conversion of raw blockchain
 * balance values (in smallest units) to human-readable decimal strings without
 * JavaScript Number precision loss.
 *
 * EVM chains use different decimal precisions:
 * - 18 decimals: ETH, MATIC, AVAX, TEMPO (native tokens)
 * - 8 decimals: WBTC
 * - 6 decimals: USDC, USDT, pathUSD
 */

import { describe, expect, it } from "vitest";
import { formatWeiToBalance } from "@/lib/wallet/fetch-balances";

describe("formatWeiToBalance", () => {
  describe("18 decimals (ETH, MATIC, TEMPO native)", () => {
    const DECIMALS = 18;

    it("should format zero balance", () => {
      expect(formatWeiToBalance(BigInt(0), DECIMALS)).toBe("0.000000");
    });

    it("should format 1 wei (smallest unit)", () => {
      expect(formatWeiToBalance(BigInt(1), DECIMALS)).toBe("0.000000");
    });

    it("should format 1 gwei (1e9 wei)", () => {
      const oneGwei = BigInt("1000000000");
      expect(formatWeiToBalance(oneGwei, DECIMALS)).toBe("0.000000");
    });

    it("should format 1 ETH exactly", () => {
      const oneEth = BigInt("1000000000000000000");
      expect(formatWeiToBalance(oneEth, DECIMALS)).toBe("1.000000");
    });

    it("should format 0.5 ETH", () => {
      const halfEth = BigInt("500000000000000000");
      expect(formatWeiToBalance(halfEth, DECIMALS)).toBe("0.500000");
    });

    it("should format 1.5 ETH", () => {
      const onePointFive = BigInt("1500000000000000000");
      expect(formatWeiToBalance(onePointFive, DECIMALS)).toBe("1.500000");
    });

    it("should format 0.123456 ETH (6 decimal precision)", () => {
      const amount = BigInt("123456000000000000");
      expect(formatWeiToBalance(amount, DECIMALS)).toBe("0.123456");
    });

    it("should format 0.000001 ETH (minimum displayable)", () => {
      const microEth = BigInt("1000000000000");
      expect(formatWeiToBalance(microEth, DECIMALS)).toBe("0.000001");
    });

    it("should format large balance (1000 ETH)", () => {
      const thousandEth = BigInt("1000000000000000000000");
      expect(formatWeiToBalance(thousandEth, DECIMALS)).toBe("1000.000000");
    });

    it("should format very large balance (1 million ETH)", () => {
      const millionEth = BigInt("1000000000000000000000000");
      expect(formatWeiToBalance(millionEth, DECIMALS)).toBe("1000000.000000");
    });

    it("should handle real RPC hex response (0x de0b6b3a7640000 = 1 ETH)", () => {
      const fromHex = BigInt("0xde0b6b3a7640000");
      expect(formatWeiToBalance(fromHex, DECIMALS)).toBe("1.000000");
    });

    it("should handle real RPC hex response (0.042 ETH)", () => {
      const fromHex = BigInt("0x9536c708910000"); // 0.042 ETH
      expect(formatWeiToBalance(fromHex, DECIMALS)).toBe("0.042000");
    });
  });

  describe("6 decimals (USDC, USDT, pathUSD)", () => {
    const DECIMALS = 6;

    it("should format zero balance", () => {
      expect(formatWeiToBalance(BigInt(0), DECIMALS)).toBe("0.000000");
    });

    it("should format 1 USDC exactly", () => {
      const oneUsdc = BigInt("1000000");
      expect(formatWeiToBalance(oneUsdc, DECIMALS)).toBe("1.000000");
    });

    it("should format 0.01 USDC (1 cent)", () => {
      const oneCent = BigInt("10000");
      expect(formatWeiToBalance(oneCent, DECIMALS)).toBe("0.010000");
    });

    it("should format 0.000001 USDC (smallest unit)", () => {
      const smallest = BigInt("1");
      expect(formatWeiToBalance(smallest, DECIMALS)).toBe("0.000001");
    });

    it("should format 100 USDC", () => {
      const hundred = BigInt("100000000");
      expect(formatWeiToBalance(hundred, DECIMALS)).toBe("100.000000");
    });

    it("should format 1000000 USDC (1 million)", () => {
      const million = BigInt("1000000000000");
      expect(formatWeiToBalance(million, DECIMALS)).toBe("1000000.000000");
    });

    it("should format 99.99 USDC", () => {
      const amount = BigInt("99990000");
      expect(formatWeiToBalance(amount, DECIMALS)).toBe("99.990000");
    });
  });

  describe("8 decimals (WBTC)", () => {
    const DECIMALS = 8;

    it("should format zero balance", () => {
      expect(formatWeiToBalance(BigInt(0), DECIMALS)).toBe("0.000000");
    });

    it("should format 1 WBTC exactly", () => {
      const oneWbtc = BigInt("100000000");
      expect(formatWeiToBalance(oneWbtc, DECIMALS)).toBe("1.000000");
    });

    it("should format 0.001 WBTC", () => {
      const amount = BigInt("100000");
      expect(formatWeiToBalance(amount, DECIMALS)).toBe("0.001000");
    });

    it("should format 0.00000001 WBTC (1 satoshi)", () => {
      const oneSat = BigInt("1");
      expect(formatWeiToBalance(oneSat, DECIMALS)).toBe("0.000000");
    });

    it("should format 21 WBTC (max supply reference)", () => {
      const amount = BigInt("2100000000");
      expect(formatWeiToBalance(amount, DECIMALS)).toBe("21.000000");
    });
  });

  describe("Testnet mock balances (treated as zero)", () => {
    const DECIMALS = 18;

    it("should return zero for TEMPO testnet mock balance", () => {
      // This is the actual hex value returned by TEMPO testnet RPC for new accounts
      // 0x9612084f0316e0ebd5182f398e5195a51b5ca47667d4c9b26c9b26c9b26c9b2
      const tempoMock = BigInt(
        "0x9612084f0316e0ebd5182f398e5195a51b5ca47667d4c9b26c9b26c9b26c9b2"
      );
      expect(formatWeiToBalance(tempoMock, DECIMALS)).toBe("0.000000");
    });

    it("should return zero for balance exceeding 1 trillion tokens", () => {
      // 1 trillion + 1 token in wei
      const overTrillion = BigInt("1000000000001000000000000000000");
      expect(formatWeiToBalance(overTrillion, DECIMALS)).toBe("0.000000");
    });

    it("should NOT return zero for exactly 1 trillion tokens", () => {
      // Exactly 1 trillion tokens in wei
      const oneTrillion = BigInt("1000000000000000000000000000000");
      expect(formatWeiToBalance(oneTrillion, DECIMALS)).toBe(
        "1000000000000.000000"
      );
    });

    it("should NOT return zero for 999 billion tokens", () => {
      // 999 billion tokens in wei
      const underTrillion = BigInt("999000000000000000000000000000");
      expect(formatWeiToBalance(underTrillion, DECIMALS)).toBe(
        "999000000000.000000"
      );
    });

    it("should handle repeating pattern mock values as zero", () => {
      // Some testnets use repeating patterns like 42424242...
      const repeatingMock = BigInt(
        "424242424242424242424242424242424242424242424242"
      );
      expect(formatWeiToBalance(repeatingMock, DECIMALS)).toBe("0.000000");
    });
  });

  describe("Rounding behavior", () => {
    const DECIMALS = 18;

    it("should round up when 7th decimal >= 5", () => {
      // 1.9999995 ETH should round to 2.000000
      const amount = BigInt("1999999500000000000");
      expect(formatWeiToBalance(amount, DECIMALS)).toBe("2.000000");
    });

    it("should round down when 7th decimal < 5", () => {
      // 1.9999994 ETH should round to 1.999999
      const amount = BigInt("1999999400000000000");
      expect(formatWeiToBalance(amount, DECIMALS)).toBe("1.999999");
    });

    it("should handle rounding at exactly .5", () => {
      // 0.0000005 should round to 0.000001
      const amount = BigInt("500000000000");
      expect(formatWeiToBalance(amount, DECIMALS)).toBe("0.000001");
    });

    it("should handle carry from rounding (0.999999x -> 1.000000)", () => {
      // 0.9999999 ETH should round to 1.000000
      const amount = BigInt("999999950000000000");
      expect(formatWeiToBalance(amount, DECIMALS)).toBe("1.000000");
    });

    it("should handle carry with large whole part", () => {
      // 999.9999995 should round to 1000.000000
      const amount = BigInt("999999999500000000000");
      expect(formatWeiToBalance(amount, DECIMALS)).toBe("1000.000000");
    });
  });

  describe("Custom display decimals", () => {
    const DECIMALS = 18;

    it("should format with 2 decimal places", () => {
      const amount = BigInt("1234567890000000000");
      expect(formatWeiToBalance(amount, DECIMALS, 2)).toBe("1.23");
    });

    it("should format with 4 decimal places", () => {
      const amount = BigInt("1234567890000000000");
      expect(formatWeiToBalance(amount, DECIMALS, 4)).toBe("1.2346");
    });

    it("should format with 8 decimal places", () => {
      const amount = BigInt("1234567890000000000");
      expect(formatWeiToBalance(amount, DECIMALS, 8)).toBe("1.23456789");
    });

    it("should format zero with custom decimals", () => {
      expect(formatWeiToBalance(BigInt(0), DECIMALS, 2)).toBe("0.00");
      expect(formatWeiToBalance(BigInt(0), DECIMALS, 4)).toBe("0.0000");
    });
  });

  describe("Edge cases", () => {
    it("should handle 0 decimals (whole number tokens)", () => {
      const amount = BigInt("42");
      expect(formatWeiToBalance(amount, 0)).toBe("42.000000");
    });

    it("should handle very high decimal tokens (24 decimals)", () => {
      const amount = BigInt("1000000000000000000000000"); // 1 token with 24 decimals
      expect(formatWeiToBalance(amount, 24)).toBe("1.000000");
    });

    it("should handle amount smaller than display precision", () => {
      // 1 wei with 18 decimals = 0.000000000000000001, displays as 0.000000
      const oneWei = BigInt(1);
      expect(formatWeiToBalance(oneWei, 18)).toBe("0.000000");
    });

    it("should preserve leading zeros in fractional part", () => {
      // 0.000123 ETH
      const amount = BigInt("123000000000000");
      expect(formatWeiToBalance(amount, 18)).toBe("0.000123");
    });

    it("should handle BigInt from hex string", () => {
      // Common pattern when parsing RPC responses
      const hexBalance = "0x4563918244f40000"; // 5 ETH
      const amount = BigInt(hexBalance);
      expect(formatWeiToBalance(amount, 18)).toBe("5.000000");
    });
  });

  describe("Real-world chain scenarios", () => {
    describe("Ethereum Mainnet", () => {
      it("should format typical gas fee amount (0.002 ETH)", () => {
        const gasFee = BigInt("2000000000000000");
        expect(formatWeiToBalance(gasFee, 18)).toBe("0.002000");
      });

      it("should format typical staking amount (32 ETH)", () => {
        const staking = BigInt("32000000000000000000");
        expect(formatWeiToBalance(staking, 18)).toBe("32.000000");
      });
    });

    describe("Base / Optimism (L2)", () => {
      it("should format sub-cent gas fees (0.000042 ETH)", () => {
        const l2Gas = BigInt("42000000000000");
        expect(formatWeiToBalance(l2Gas, 18)).toBe("0.000042");
      });
    });

    describe("TEMPO Testnet", () => {
      it("should handle faucet drip amount (1M pathUSD)", () => {
        // 1 million pathUSD with 6 decimals
        const faucetDrip = BigInt("1000000000000");
        expect(formatWeiToBalance(faucetDrip, 6)).toBe("1000000.000000");
      });

      it("should treat native TEMPO mock balance as zero", () => {
        // The massive value TEMPO testnet returns - treated as zero since it's meaningless
        const mockBalance = BigInt(
          "4242424242424242424242424242424242424242424242424242424242424242424242424242"
        );
        expect(formatWeiToBalance(mockBalance, 18)).toBe("0.000000");
      });
    });

    describe("Stablecoin transfers", () => {
      it("should format $1.50 USDC transfer", () => {
        const amount = BigInt("1500000");
        expect(formatWeiToBalance(amount, 6)).toBe("1.500000");
      });

      it("should format $1000.00 USDT transfer", () => {
        const amount = BigInt("1000000000");
        expect(formatWeiToBalance(amount, 6)).toBe("1000.000000");
      });

      it("should format dust amount (0.000001 USDC)", () => {
        const dust = BigInt("1");
        expect(formatWeiToBalance(dust, 6)).toBe("0.000001");
      });
    });
  });
});
