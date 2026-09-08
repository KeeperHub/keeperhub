import { describe, expect, it } from "vitest";
import { synthesiseProtocolTemplate } from "@/lib/workflow/codegen/protocol-synthesiser";

describe("synthesiseProtocolTemplate", () => {
  it("returns null for non-protocol action ids", () => {
    expect(synthesiseProtocolTemplate("web3/check-balance")).toBeNull();
    expect(synthesiseProtocolTemplate("not-a-protocol/anything")).toBeNull();
    expect(synthesiseProtocolTemplate("malformed-no-slash")).toBeNull();
  });

  describe("ccip-check-bridge-balance (read, user-specified address)", () => {
    const actionId = "chainlink/ccip-check-bridge-balance";

    it("emits a viem readContract template with sepolia config", () => {
      const out = synthesiseProtocolTemplate(actionId, {
        network: "11155111",
        contractAddress: "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
      });

      expect(out).not.toBeNull();
      const code = out as string;

      expect(code).toContain('import { createPublicClient, http } from "viem"');
      expect(code).toContain('import { sepolia } from "viem/chains"');
      expect(code).toContain(
        'const CONTRACT_ADDRESS = "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05" as const'
      );
      expect(code).toContain(
        "export async function ccipCheckBridgeBalanceStep"
      );
      expect(code).toContain('"use step"');
      expect(code).toContain("client.readContract");
      expect(code).toContain('functionName: "balanceOf"');
      expect(code).toContain("args: [input.account]");
      expect(code).toContain("chain: sepolia");
      expect(code).toContain("process.env.SEPOLIA_RPC_URL");

      // No write-only constructs leaking into a read template
      expect(code).not.toContain("walletClient");
      expect(code).not.toContain("WALLET_PRIVATE_KEY");
      expect(code).not.toContain("simulateContract");

      // Must not be the stub
      expect(code).not.toContain("Executing action");
    });

    it("emits a placeholder address when user-specified address is missing", () => {
      const out = synthesiseProtocolTemplate(actionId, {
        network: "11155111",
      });
      expect(out).toContain(
        '"0x0000000000000000000000000000000000000000" as const'
      );
      expect(out).toContain(
        "// this contract address is user-specified at runtime"
      );
    });

    it("falls back to defineChain when no network is selected", () => {
      const out = synthesiseProtocolTemplate(actionId, {});
      expect(out).toContain('import { defineChain } from "viem"');
      expect(out).toContain("// no network selected on this node");
    });
  });

  describe("ccip-approve-bridge-token (write)", () => {
    const actionId = "chainlink/ccip-approve-bridge-token";

    it("emits a viem write template with simulate, write, wait", () => {
      const out = synthesiseProtocolTemplate(actionId, {
        network: "11155111",
        contractAddress: "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
      });

      expect(out).not.toBeNull();
      const code = out as string;

      expect(code).toContain(
        'import { createPublicClient, createWalletClient, http } from "viem"'
      );
      expect(code).toContain(
        'import { privateKeyToAccount } from "viem/accounts"'
      );
      expect(code).toContain('import { sepolia } from "viem/chains"');
      expect(code).toContain(
        "export async function ccipApproveBridgeTokenStep"
      );

      // Pipeline: simulate → write → wait
      expect(code).toContain("publicClient.simulateContract");
      expect(code).toContain("walletClient.writeContract(request)");
      expect(code).toContain("publicClient.waitForTransactionReceipt");

      expect(code).toContain('functionName: "approve"');
      // approve takes (address spender, uint256 amount). Address passes through,
      // uint256 is wrapped with BigInt.
      expect(code).toContain("input.spender, BigInt(input.amount)");

      // Output type for write actions is the fixed transaction shape
      // biome-ignore lint/suspicious/noTemplateCurlyInString: assertion against literal output
      expect(code).toContain("transactionHash: `0x${string}`");
      expect(code).toContain("gasUsed: string");

      // No payable variant value leak (approve is non-payable)
      expect(code).not.toContain("input.ethValue");
    });
  });

  describe("type emission edge cases", () => {
    it("maps an address input field to a viem-shaped Input type", () => {
      const out = synthesiseProtocolTemplate(
        "chainlink/ccip-check-bridge-balance",
        { network: "11155111", contractAddress: "0xabc" }
      );
      // biome-ignore lint/suspicious/noTemplateCurlyInString: assertion against literal output
      expect(out).toContain("account: `0x${string}`");
    });

    it("maps a uint256 input field to string and casts via BigInt at call site", () => {
      const out = synthesiseProtocolTemplate(
        "chainlink/ccip-approve-bridge-token",
        { network: "11155111", contractAddress: "0xabc" }
      );
      expect(out).toContain("amount: string");
      expect(out).toContain("BigInt(input.amount)");
    });
  });

  describe("inline ABI present (KEEP-396)", () => {
    it("uses the inline Pool ABI for aave-v3/supply (no synthesis fallback)", () => {
      const out = synthesiseProtocolTemplate("aave-v3/supply", {
        network: "1",
      });

      expect(out).not.toBeNull();
      const code = out as string;

      // Real Aave V3 pool address on mainnet, resolved per chain.
      expect(code).toContain('"0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"');

      // Function name + positional arg casts come from the resolved ABI fragment.
      expect(code).toContain('functionName: "supply"');
      expect(code).toContain(
        "args: [input.asset, BigInt(input.amount), input.onBehalfOf, BigInt(input.referralCode)]"
      );

      // Write-shaped output template.
      expect(code).toContain("export async function supplyStep");
      expect(code).toContain("publicClient.simulateContract");

      // Inline ABI is now present on the pool contract, so the synthesis
      // fallback comment must NOT appear.
      expect(code).not.toContain(
        "// ABI fragment synthesised from protocol action metadata"
      );
    });
  });

  describe("tuple input reconstruction", () => {
    it("wraps uniswap quote-exact-input args in a single tuple object", () => {
      const out = synthesiseProtocolTemplate("uniswap/quote-exact-input", {
        network: "1",
      });

      expect(out).not.toBeNull();
      const code = out as string;

      // The contract takes a single tuple param; user-facing inputs are flat.
      // Args MUST be a single object literal, not separate positional args.
      expect(code).toContain(
        "args: [{ tokenIn: input.tokenIn, tokenOut: input.tokenOut, amountIn: BigInt(input.amountIn), fee: BigInt(input.fee), sqrtPriceLimitX96: BigInt(input.sqrtPriceLimitX96) }]"
      );

      // Multi-output read uses indexed result destructuring.
      expect(code).toContain(
        "amountOut: String((result as readonly unknown[])[0])"
      );
    });
  });

  describe("decimals annotation in Input type", () => {
    it("emits a wei + parseUnits hint for inputs with decimals: <number>", () => {
      // aerodrome/create-lock has `_value: uint256, decimals: 18`
      const out = synthesiseProtocolTemplate("aerodrome/create-lock", {
        network: "8453",
      });
      expect(out).not.toBeNull();
      const code = out as string;

      // The annotation MUST appear on the line above the typed field.
      expect(code).toContain(
        "/** denominated in wei (10^18 units) -- convert with parseUnits(value, 18) for human input */"
      );
      // Annotation does not change the cast in args.
      expect(code).toContain("BigInt(input._value)");

      // Sibling field without decimals stays unannotated.
      expect(code).toContain("_lockDuration: string;");
      const lockDurationIndex = code.indexOf("_lockDuration: string;");
      const annotationBeforeLockDuration = code
        .slice(0, lockDurationIndex)
        .endsWith("/** denominated in wei (10^18 units)");
      expect(annotationBeforeLockDuration).toBe(false);
    });

    it("emits a runtime-lookup TODO for inputs with decimals: true", () => {
      // morpho/supply has `assets: uint256, decimals: true`
      const out = synthesiseProtocolTemplate("morpho/supply", { network: "1" });
      expect(out).not.toBeNull();
      expect(out).toContain(
        "/** denominated in the token's smallest unit -- token decimals must be looked up at runtime; replace with parseUnits(value, <decimals>) once known */"
      );
    });
  });

  describe("ccip-send (payable + nested tuple + tuple[] + receiver pad)", () => {
    it("reconstructs the message struct and inlines the receiver pad transform", () => {
      const out = synthesiseProtocolTemplate("chainlink/ccip-send", {
        network: "11155111",
      });

      expect(out).not.toBeNull();
      const code = out as string;

      // First arg is a top-level scalar; second is the message tuple.
      expect(code).toContain(
        "args: [BigInt(input.destinationChainSelector), {"
      );

      // Receiver field gets the padAddressToBytes transform inlined.
      expect(code).toContain(
        '("0x" + (input.receiver).slice(2).padStart(64, "0") as'
      );

      // tokenAmounts (tuple[]) becomes an array map with element-wise casts.
      expect(code).toContain(
        "tokenAmounts: (input.tokenAmounts).map((t) => ({ token: t.token, amount: BigInt(t.amount) }))"
      );

      // payable: ethValue line emitted only for payable functions.
      expect(code).toContain(
        "value: input.ethValue ? BigInt(input.ethValue) : undefined"
      );
    });
  });
});
