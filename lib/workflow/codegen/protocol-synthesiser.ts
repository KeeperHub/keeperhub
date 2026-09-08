import { getEncodeTransformKind } from "@/lib/protocol-encode-transforms";
import type { ProtocolActionInput } from "@/lib/protocol-registry";
import {
  type AbiFunctionFragment,
  type AbiParameter,
  getProtocolActionContext,
  type ProtocolActionContext,
} from "./protocol-metadata";

const ARRAY_SUFFIX_REGEX = /\[\d*\]$/;
const KEBAB_SEGMENT_REGEX = /-([a-z0-9])/g;

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal viem template-literal type emitted into generated code
const HEX_BYTES_TYPE = "`0x${string}`";

type ChainEntry = {
  varName: string;
  envVarName: string;
};

const VIEM_CHAINS: Record<string, ChainEntry> = {
  "1": { varName: "mainnet", envVarName: "MAINNET_RPC_URL" },
  "10": { varName: "optimism", envVarName: "OPTIMISM_RPC_URL" },
  "56": { varName: "bsc", envVarName: "BSC_RPC_URL" },
  "97": { varName: "bscTestnet", envVarName: "BSC_TESTNET_RPC_URL" },
  "137": { varName: "polygon", envVarName: "POLYGON_RPC_URL" },
  "8453": { varName: "base", envVarName: "BASE_RPC_URL" },
  "42161": { varName: "arbitrum", envVarName: "ARBITRUM_RPC_URL" },
  "43113": { varName: "avalancheFuji", envVarName: "AVALANCHE_FUJI_RPC_URL" },
  "43114": { varName: "avalanche", envVarName: "AVALANCHE_RPC_URL" },
  "80002": { varName: "polygonAmoy", envVarName: "POLYGON_AMOY_RPC_URL" },
  "84532": { varName: "baseSepolia", envVarName: "BASE_SEPOLIA_RPC_URL" },
  "421614": {
    varName: "arbitrumSepolia",
    envVarName: "ARBITRUM_SEPOLIA_RPC_URL",
  },
  "11155111": { varName: "sepolia", envVarName: "SEPOLIA_RPC_URL" },
  "11155420": {
    varName: "optimismSepolia",
    envVarName: "OPTIMISM_SEPOLIA_RPC_URL",
  },
};

type ResolvedChain =
  | { kind: "known"; chainId: string; entry: ChainEntry }
  | { kind: "unknown"; chainId: string }
  | { kind: "missing" };

type ResolvedAddress =
  | { kind: "literal"; value: string }
  | { kind: "user-specified-with-value"; value: string }
  | { kind: "user-specified-placeholder" }
  | { kind: "missing-for-chain"; chainId: string };

type SynthesisInputs = {
  ctx: ProtocolActionContext;
  chain: ResolvedChain;
  address: ResolvedAddress;
  fnVarName: string;
};

type ComponentLike = {
  name?: string;
  type: string;
  components?: ComponentLike[];
};

function camelCaseSlug(slug: string): string {
  return slug.replace(KEBAB_SEGMENT_REGEX, (_m, c: string) => c.toUpperCase());
}

// -- Chain & address resolution ----------------------------------------------

function resolveChain(
  ctx: ProtocolActionContext,
  nodeConfig: Record<string, unknown> | undefined
): ResolvedChain {
  const chainId = nodeConfig?.network as string | undefined;
  if (!chainId) {
    return { kind: "missing" };
  }
  const entry = VIEM_CHAINS[chainId];
  if (!entry) {
    return { kind: "unknown", chainId };
  }
  if (
    !(ctx.contract.userSpecifiedAddress || chainId in ctx.contract.addresses)
  ) {
    return { kind: "unknown", chainId };
  }
  return { kind: "known", chainId, entry };
}

function resolveAddress(
  ctx: ProtocolActionContext,
  chain: ResolvedChain,
  nodeConfig: Record<string, unknown> | undefined
): ResolvedAddress {
  if (ctx.contract.userSpecifiedAddress) {
    const userValue = nodeConfig?.contractAddress as string | undefined;
    return userValue
      ? { kind: "user-specified-with-value", value: userValue }
      : { kind: "user-specified-placeholder" };
  }
  if (chain.kind === "known" || chain.kind === "unknown") {
    const value = ctx.contract.addresses[chain.chainId];
    if (value) {
      return { kind: "literal", value };
    }
    return { kind: "missing-for-chain", chainId: chain.chainId };
  }
  const firstChainId = Object.keys(ctx.contract.addresses)[0];
  if (firstChainId) {
    return { kind: "literal", value: ctx.contract.addresses[firstChainId] };
  }
  return { kind: "user-specified-placeholder" };
}

// -- Type emission -----------------------------------------------------------

function abiTypeToTs(
  typeName: string,
  components: ComponentLike[] | undefined
): string {
  const arrayMatch = typeName.match(ARRAY_SUFFIX_REGEX);
  if (arrayMatch) {
    const inner = typeName.slice(0, arrayMatch.index);
    return `${abiTypeToTs(inner, components)}[]`;
  }
  if (typeName === "tuple") {
    return buildInlineObjectType(components ?? []);
  }
  if (typeName === "address" || typeName === "address payable") {
    return HEX_BYTES_TYPE;
  }
  if (typeName === "bool") {
    return "boolean";
  }
  if (typeName === "string") {
    return "string";
  }
  if (typeName.startsWith("bytes")) {
    return HEX_BYTES_TYPE;
  }
  if (typeName.startsWith("uint") || typeName.startsWith("int")) {
    return "string";
  }
  return "unknown";
}

function buildInlineObjectType(components: ComponentLike[]): string {
  if (components.length === 0) {
    return "Record<string, unknown>";
  }
  const fields = components.map((c) => {
    const ts = abiTypeToTs(c.type, c.components);
    return `${c.name ?? "_"}: ${ts}`;
  });
  return `{ ${fields.join("; ")} }`;
}

function decimalsAnnotation(
  decimals: number | boolean | undefined
): string | null {
  if (decimals === undefined) {
    return null;
  }
  if (typeof decimals === "number") {
    return `  /** denominated in wei (10^${decimals} units) -- convert with parseUnits(value, ${decimals}) for human input */`;
  }
  // decimals: true -- token decimals must be looked up at runtime
  return "  /** denominated in the token's smallest unit -- token decimals must be looked up at runtime; replace with parseUnits(value, <decimals>) once known */";
}

function buildInputType(ctx: ProtocolActionContext): string {
  if (ctx.action.inputs.length === 0) {
    return "type Input = Record<string, never>;";
  }
  const lines: string[] = ["type Input = {"];
  for (const inp of ctx.action.inputs) {
    const annotation = decimalsAnnotation(inp.decimals);
    if (annotation) {
      lines.push(annotation);
    }
    lines.push(`  ${inp.name}: ${abiTypeToTs(inp.type, inp.components)};`);
  }
  lines.push("};");
  return lines.join("\n");
}

// -- Args reconstruction (ABI-shape driven) ----------------------------------

function isUintOrInt(t: string): boolean {
  return t.startsWith("uint") || t.startsWith("int");
}

function applyEncodeTransform(
  expr: string,
  ctx: ProtocolActionContext,
  fieldName: string
): string {
  const kind = getEncodeTransformKind(
    ctx.protocolSlug,
    ctx.actionSlug,
    fieldName
  );
  if (!kind) {
    return expr;
  }
  if (kind === "padAddressToBytes") {
    return `("0x" + (${expr}).slice(2).padStart(64, "0") as ${HEX_BYTES_TYPE})`;
  }
  // Exhaustive over EncodeTransformKind. Adding a new kind to the registry
  // requires a new branch above; until then the synthesiser preserves the
  // raw expression rather than silently dropping the transform.
  return expr;
}

function castScalar(expr: string, solType: string): string {
  if (isUintOrInt(solType)) {
    return `BigInt(${expr})`;
  }
  return expr;
}

function buildArgExpression(
  param: AbiParameter,
  sourceVar: string,
  ctx: ProtocolActionContext,
  applyTransforms: boolean
): string {
  const fieldName = param.name ?? "_";
  const access = `${sourceVar}.${fieldName}`;

  const arrayMatch = param.type.match(ARRAY_SUFFIX_REGEX);
  if (arrayMatch) {
    const innerType = param.type.slice(0, arrayMatch.index);
    if (innerType === "tuple") {
      const components = param.components ?? [];
      const innerExprs = components.map((c) => {
        const inner = buildArgExpression(c, "t", ctx, false);
        return `${c.name ?? "_"}: ${inner}`;
      });
      return `(${access}).map((t) => ({ ${innerExprs.join(", ")} }))`;
    }
    // Scalar array (e.g. uint256[]) -- viem accepts native arrays. For uint/int
    // arrays we map BigInt elementwise.
    if (isUintOrInt(innerType)) {
      return `(${access}).map((v) => BigInt(v))`;
    }
    return `${access}`;
  }

  if (param.type === "tuple") {
    const components = param.components ?? [];
    const innerExprs = components.map((c) => {
      const inner = buildArgExpression(c, sourceVar, ctx, applyTransforms);
      return `${c.name ?? "_"}: ${inner}`;
    });
    return `{ ${innerExprs.join(", ")} }`;
  }

  // Scalar leaf
  const cast = castScalar(access, param.type);
  if (applyTransforms) {
    return applyEncodeTransform(cast, ctx, fieldName);
  }
  return cast;
}

function buildArgsList(ctx: ProtocolActionContext): string {
  const parts = ctx.abiFragment.inputs.map((p) =>
    buildArgExpression(p, "input", ctx, true)
  );
  return parts.join(", ");
}

// -- Output type & result mapping for reads ---------------------------------

type ReadOutputShape =
  | { kind: "void" }
  | { kind: "single" }
  | { kind: "multi"; fieldNames: string[] };

function classifyReadOutputs(ctx: ProtocolActionContext): ReadOutputShape {
  const outputs = ctx.abiFragment.outputs ?? [];
  if (outputs.length === 0) {
    return { kind: "void" };
  }
  if (outputs.length === 1) {
    return { kind: "single" };
  }
  return {
    kind: "multi",
    fieldNames: outputs.map((out, i) =>
      out.name && out.name.length > 0 ? out.name : `output${i}`
    ),
  };
}

function buildReadOutputType(ctx: ProtocolActionContext): string {
  const shape = classifyReadOutputs(ctx);
  if (shape.kind === "void") {
    return [
      "type Output =",
      "  | { success: true }",
      "  | { success: false; error: string };",
    ].join("\n");
  }
  if (shape.kind === "single") {
    return [
      "type Output =",
      "  | { success: true; result: string }",
      "  | { success: false; error: string };",
    ].join("\n");
  }
  const namedFields = shape.fieldNames.map((name) => `      ${name}: string;`);
  return [
    "type Output =",
    "  | {",
    "      success: true;",
    ...namedFields,
    "    }",
    "  | { success: false; error: string };",
  ].join("\n");
}

function buildReadResultMapping(ctx: ProtocolActionContext): string {
  const shape = classifyReadOutputs(ctx);
  if (shape.kind === "void") {
    return "    return { success: true };";
  }
  if (shape.kind === "single") {
    return "    return { success: true, result: String(result) };";
  }
  const fields = shape.fieldNames.map(
    (name, i) => `      ${name}: String((result as readonly unknown[])[${i}]),`
  );
  return ["    return {", "      success: true,", ...fields, "    };"].join(
    "\n"
  );
}

// -- ABI fragment formatting ------------------------------------------------

function formatAbiParameter(param: AbiParameter, indent: string): string {
  const lines: string[] = [`${indent}{`];
  if (param.name) {
    lines.push(`${indent}  name: "${param.name}",`);
  }
  lines.push(`${indent}  type: "${param.type}",`);
  if (param.components && param.components.length > 0) {
    lines.push(`${indent}  components: [`);
    for (const c of param.components) {
      lines.push(`${formatAbiParameter(c, `${indent}    `)},`);
    }
    lines.push(`${indent}  ],`);
  }
  lines.push(`${indent}}`);
  return lines.join("\n");
}

function formatAbiFragment(fragment: AbiFunctionFragment): string {
  const lines: string[] = ["[", "  {", '    type: "function",'];
  lines.push(`    name: "${fragment.name}",`);
  if (fragment.stateMutability) {
    lines.push(`    stateMutability: "${fragment.stateMutability}",`);
  }
  lines.push("    inputs: [");
  for (const inp of fragment.inputs) {
    lines.push(`${formatAbiParameter(inp, "      ")},`);
  }
  lines.push("    ],");
  lines.push("    outputs: [");
  for (const out of fragment.outputs ?? []) {
    lines.push(`${formatAbiParameter(out, "      ")},`);
  }
  lines.push("    ],");
  lines.push("  },");
  lines.push("] as const");
  return lines.join("\n");
}

// -- Chain / address emission -----------------------------------------------

function emitChainImport(chain: ResolvedChain): {
  importLine: string;
  chainExpression: string;
  rpcExpression: string;
  warnings: string[];
} {
  if (chain.kind === "known") {
    return {
      importLine: `import { ${chain.entry.varName} } from "viem/chains";`,
      chainExpression: chain.entry.varName,
      rpcExpression: `process.env.${chain.entry.envVarName}`,
      warnings: [],
    };
  }
  if (chain.kind === "unknown") {
    return {
      importLine: `import { defineChain } from "viem";`,
      chainExpression: "chain",
      rpcExpression: "process.env.RPC_URL",
      warnings: [
        `// chain id ${chain.chainId} is not in viem/chains; define it manually below`,
      ],
    };
  }
  return {
    importLine: `import { defineChain } from "viem";`,
    chainExpression: "chain",
    rpcExpression: "process.env.RPC_URL",
    warnings: [
      "// no network selected on this node; replace 'chain' with the chain you target",
    ],
  };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function addressBlock(value: string): string {
  return `const CONTRACT_ADDRESS = "${value}" as const;`;
}

function emitAddressBlock(address: ResolvedAddress): {
  block: string;
  warnings: string[];
} {
  if (
    address.kind === "literal" ||
    address.kind === "user-specified-with-value"
  ) {
    return { block: addressBlock(address.value), warnings: [] };
  }
  const warning =
    address.kind === "user-specified-placeholder"
      ? "// this contract address is user-specified at runtime; replace with the token address you target"
      : `// no deployment recorded for chain id ${address.chainId}; replace with the address you target`;
  return { block: addressBlock(ZERO_ADDRESS), warnings: [warning] };
}

function emitAbiSourceWarning(ctx: ProtocolActionContext): string[] {
  if (ctx.abiSource === "synthesised-from-action-metadata") {
    return [
      "// ABI fragment synthesised from protocol action metadata (proxy contract, no inline ABI).",
      "// At runtime this contract resolves its ABI dynamically; if the on-chain function signature",
      "// changes you may need to update the inlined ABI below.",
    ];
  }
  return [];
}

// -- Template parts --------------------------------------------------------

type TemplateParts = {
  imports: string[];
  warnings: string[];
  addressLine: string;
  abiLine: string;
  inputType: string;
  outputType: string;
  bodyLines: string[]; // function body lines with input.X (no input/output type refs)
};

type SharedSynthFrame = {
  ctx: ProtocolActionContext;
  chainEmission: ReturnType<typeof emitChainImport>;
  addressEmission: ReturnType<typeof emitAddressBlock>;
  argsList: string;
};

function buildSharedFrame(inputs: SynthesisInputs): SharedSynthFrame {
  return {
    ctx: inputs.ctx,
    chainEmission: emitChainImport(inputs.chain),
    addressEmission: emitAddressBlock(inputs.address),
    argsList: buildArgsList(inputs.ctx),
  };
}

function commonTemplateFields(
  frame: SharedSynthFrame
): Pick<TemplateParts, "warnings" | "addressLine" | "abiLine" | "inputType"> {
  const { ctx, chainEmission, addressEmission } = frame;
  return {
    warnings: [
      ...emitAbiSourceWarning(ctx),
      ...chainEmission.warnings,
      ...addressEmission.warnings,
    ],
    addressLine: addressEmission.block,
    abiLine: `const ABI = ${formatAbiFragment(ctx.abiFragment)};`,
    inputType: buildInputType(ctx),
  };
}

function buildReadParts(inputs: SynthesisInputs): TemplateParts {
  const frame = buildSharedFrame(inputs);
  const { ctx, chainEmission, argsList } = frame;
  const resultMapping = buildReadResultMapping(ctx);

  const bodyLines: string[] = [
    "  const client = createPublicClient({",
    `    chain: ${chainEmission.chainExpression},`,
    `    transport: http(${chainEmission.rpcExpression}),`,
    "  });",
    "  try {",
    "    const result = await client.readContract({",
    "      address: CONTRACT_ADDRESS,",
    "      abi: ABI,",
    `      functionName: "${ctx.action.function}",`,
    `      args: [${argsList}],`,
    "    });",
    resultMapping,
    "  } catch (error) {",
    "    return {",
    "      success: false,",
    "      error: error instanceof Error ? error.message : String(error),",
    "    };",
    "  }",
  ];

  return {
    ...commonTemplateFields(frame),
    imports: [
      `import { createPublicClient, http } from "viem";`,
      chainEmission.importLine,
    ],
    outputType: buildReadOutputType(ctx),
    bodyLines,
  };
}

function renderStandalone(parts: TemplateParts, fnVarName: string): string {
  return [
    ...parts.imports,
    "",
    ...parts.warnings,
    parts.addressLine,
    "",
    parts.abiLine,
    "",
    parts.inputType,
    "",
    parts.outputType,
    "",
    `export async function ${fnVarName}(input: Input): Promise<Output> {`,
    `  "use step";`,
    ...parts.bodyLines,
    "}",
    "",
  ].join("\n");
}

// -- Write template --------------------------------------------------------

function buildWriteOutputType(): string {
  return [
    "type Output =",
    `  | { success: true; transactionHash: ${HEX_BYTES_TYPE}; gasUsed: string }`,
    "  | { success: false; error: string };",
  ].join("\n");
}

function buildWriteParts(inputs: SynthesisInputs): TemplateParts {
  const frame = buildSharedFrame(inputs);
  const { ctx, chainEmission, argsList } = frame;

  const valueLine = ctx.action.payable
    ? "      value: input.ethValue ? BigInt(input.ethValue) : undefined,"
    : null;

  const simulateLines: string[] = [
    "    const { request } = await publicClient.simulateContract({",
    "      account,",
    "      address: CONTRACT_ADDRESS,",
    "      abi: ABI,",
    `      functionName: "${ctx.action.function}",`,
    `      args: [${argsList}],`,
  ];
  if (valueLine) {
    simulateLines.push(valueLine);
  }
  simulateLines.push("    });");

  const bodyLines: string[] = [
    "  const account = privateKeyToAccount(",
    `    process.env.WALLET_PRIVATE_KEY as ${HEX_BYTES_TYPE}`,
    "  );",
    `  const transport = http(${chainEmission.rpcExpression});`,
    "  const publicClient = createPublicClient({",
    `    chain: ${chainEmission.chainExpression},`,
    "    transport,",
    "  });",
    "  const walletClient = createWalletClient({",
    "    account,",
    `    chain: ${chainEmission.chainExpression},`,
    "    transport,",
    "  });",
    "  try {",
    ...simulateLines,
    "    const hash = await walletClient.writeContract(request);",
    "    const receipt = await publicClient.waitForTransactionReceipt({ hash });",
    "    return {",
    "      success: true,",
    "      transactionHash: hash,",
    "      gasUsed: receipt.gasUsed.toString(),",
    "    };",
    "  } catch (error) {",
    "    return {",
    "      success: false,",
    "      error: error instanceof Error ? error.message : String(error),",
    "    };",
    "  }",
  ];

  return {
    ...commonTemplateFields(frame),
    imports: [
      `import { createPublicClient, createWalletClient, http } from "viem";`,
      `import { privateKeyToAccount } from "viem/accounts";`,
      chainEmission.importLine,
    ],
    outputType: buildWriteOutputType(),
    bodyLines,
  };
}

// -- Public entries --------------------------------------------------------

function buildSynthesisInputs(
  actionId: string,
  nodeConfig?: Record<string, unknown>
): SynthesisInputs | null {
  const ctx = getProtocolActionContext(actionId);
  if (!ctx) {
    return null;
  }
  const chain = resolveChain(ctx, nodeConfig);
  const address = resolveAddress(ctx, chain, nodeConfig);
  const fnVarName = `${camelCaseSlug(ctx.actionSlug)}Step`;
  return { ctx, chain, address, fnVarName };
}

export function synthesiseProtocolTemplate(
  actionId: string,
  nodeConfig?: Record<string, unknown>
): string | null {
  const inputs = buildSynthesisInputs(actionId, nodeConfig);
  if (!inputs) {
    return null;
  }
  const parts =
    inputs.ctx.action.type === "read"
      ? buildReadParts(inputs)
      : buildWriteParts(inputs);
  return renderStandalone(parts, inputs.fnVarName);
}

// -- SDK integration -------------------------------------------------------

/**
 * SDK-shaped synthesis: returns the pieces the workflow SDK needs to
 * embed a protocol step into a generated workflow file. Constants
 * (CONTRACT_ADDRESS, ABI) are scoped inside the wrapper to avoid
 * cross-node name collisions; type aliases are dropped because the SDK
 * wrapper takes a generic Record<string, unknown>; body lines reference
 * `stepInput.X` so the SDK wrapper's input-construction stays unchanged.
 */
export type ProtocolSdkSynthesis = {
  imports: string[];
  inputs: ProtocolActionInput[];
  inlineDecls: string[]; // address const + ABI const, scoped inside the wrapper
  warnings: string[];
  bodyLines: string[]; // body referencing stepInput.X
};

// Safe to do a naive textual rebind because the body builders only ever
// reference the synthesised function's parameter (also called `input`) for
// scalar field access. Inner closures introduced by buildArgExpression for
// tuple[] handling bind to `t`, never `input`. If a future body builder
// introduces another callback parameter named `input`, this rebind will
// silently corrupt it -- prefer adding a fresh binder name (`row`, `el`)
// over reusing `input`.
const INPUT_DOT_REGEX = /\binput\./g;

function rebindInputToStepInput(line: string): string {
  return line.replace(INPUT_DOT_REGEX, "stepInput.");
}

export function synthesiseProtocolForSDK(
  actionId: string,
  nodeConfig?: Record<string, unknown>
): ProtocolSdkSynthesis | null {
  const inputs = buildSynthesisInputs(actionId, nodeConfig);
  if (!inputs) {
    return null;
  }
  const parts =
    inputs.ctx.action.type === "read"
      ? buildReadParts(inputs)
      : buildWriteParts(inputs);
  return {
    imports: parts.imports,
    inputs: inputs.ctx.action.inputs,
    inlineDecls: [parts.addressLine, parts.abiLine],
    warnings: parts.warnings,
    bodyLines: parts.bodyLines.map(rebindInputToStepInput),
  };
}
