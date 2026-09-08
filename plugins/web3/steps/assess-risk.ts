import "server-only";

import { safeFetch } from "@/lib/safe-fetch";
import { runPluginStep, type StepInput } from "@/lib/workflow/executor/step-handler";
import {
  type DecodeCalldataCoreInput,
  type DecodedParameter,
  decodeCalldata,
} from "./decode-calldata-core";

// -- Module-level constants --

const LLM_TIMEOUT_MS = 3000;

const MAX_UINT256_DECIMAL =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const MAX_UINT256_HEX =
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const LARGE_VALUE_THRESHOLD = 10;

const CRITICAL_FUNCTIONS = new Set([
  "transferOwnership",
  "renounceOwnership",
  "upgradeTo",
  "upgradeToAndCall",
  "changeAdmin",
  "setImplementation",
  "selfdestruct",
  "changeProxyAdmin",
  "setOwner",
]);

const HIGH_RISK_FUNCTIONS = new Set([
  "delegatecall",
  "emergencyWithdraw",
  "withdrawAll",
  "drain",
  "sweep",
  "migrate",
]);

const APPROVAL_FUNCTIONS = new Set(["approve", "increaseAllowance", "permit"]);

// -- Types --

type RiskLevel = "low" | "medium" | "high" | "critical";

type RiskFactor = {
  category: "approval" | "privileged" | "value" | "interaction";
  level: RiskLevel;
  description: string;
};

type AssessRiskResult =
  | {
      success: true;
      riskLevel: RiskLevel;
      riskScore: number;
      factors: string[];
      decodedFunction: string | null;
      reasoning: string;
    }
  | {
      success: false;
      error: string;
      riskLevel: "critical";
    };

export type AssessRiskCoreInput = {
  calldata: string;
  contractAddress?: string;
  value?: string;
  chain?: string;
  senderAddress?: string;
};

export type AssessRiskInput = StepInput & AssessRiskCoreInput;

// -- Risk scoring constants --

const LEVEL_SCORES: Record<RiskLevel, number> = {
  low: 15,
  medium: 40,
  high: 70,
  critical: 95,
};

const LEVEL_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// -- Risk rule functions --

function isUnlimitedValue(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === MAX_UINT256_DECIMAL) {
    return true;
  }
  if (trimmed.replace("0x", "") === MAX_UINT256_HEX) {
    return true;
  }
  return false;
}

function checkApprovalRisks(
  functionName: string | null,
  parameters: DecodedParameter[]
): RiskFactor[] {
  const factors: RiskFactor[] = [];

  if (!functionName) {
    return factors;
  }

  if (APPROVAL_FUNCTIONS.has(functionName)) {
    for (const param of parameters) {
      if (param.type === "uint256" && isUnlimitedValue(param.value)) {
        factors.push({
          category: "approval",
          level: "high",
          description: `Unlimited token approval (${functionName} with MAX_UINT256)`,
        });
        return factors;
      }
    }
    factors.push({
      category: "approval",
      level: "medium",
      description: `Token approval operation: ${functionName}`,
    });
  }

  if (functionName === "setApprovalForAll") {
    const boolParam = parameters.find((p) => p.type === "bool");
    if (boolParam?.value === "true") {
      factors.push({
        category: "approval",
        level: "high",
        description:
          "setApprovalForAll(true) grants full NFT access to operator",
      });
    }
  }

  return factors;
}

function checkPrivilegedOps(functionName: string | null): RiskFactor[] {
  if (!functionName) {
    return [];
  }

  if (CRITICAL_FUNCTIONS.has(functionName)) {
    return [
      {
        category: "privileged",
        level: "critical",
        description: `Critical privileged operation: ${functionName}`,
      },
    ];
  }

  if (HIGH_RISK_FUNCTIONS.has(functionName)) {
    return [
      {
        category: "privileged",
        level: "high",
        description: `High-risk operation: ${functionName}`,
      },
    ];
  }

  return [];
}

function checkValueRisks(value: string | undefined): RiskFactor[] {
  if (!value) {
    return [];
  }

  const numValue = Number.parseFloat(value);
  if (Number.isNaN(numValue) || numValue <= 0) {
    return [];
  }

  if (numValue >= LARGE_VALUE_THRESHOLD) {
    return [
      {
        category: "value",
        level: numValue >= 100 ? "high" : "medium",
        description: `Large value transfer: ${value} ETH`,
      },
    ];
  }

  return [];
}

function checkInteractionRisks(
  contractAddress: string | undefined,
  functionName: string | null,
  selector: string
): RiskFactor[] {
  const factors: RiskFactor[] = [];

  if (contractAddress?.toLowerCase() === ZERO_ADDRESS) {
    factors.push({
      category: "interaction",
      level: "high",
      description: "Transaction targets the zero address",
    });
  }

  if (
    functionName === "execute" ||
    functionName === "multicall" ||
    functionName === "batch"
  ) {
    factors.push({
      category: "interaction",
      level: "medium",
      description: `Generic execution pattern: ${functionName} -- review inner calls`,
    });
  }

  if (!functionName && selector !== "0x" && selector !== "") {
    factors.push({
      category: "interaction",
      level: "medium",
      description: `Unknown function selector: ${selector} -- could not decode`,
    });
  }

  return factors;
}

// -- Risk scoring helpers --

function getHigherLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

function computeRiskFromFactors(factors: RiskFactor[]): {
  riskLevel: RiskLevel;
  riskScore: number;
} {
  if (factors.length === 0) {
    return { riskLevel: "low", riskScore: 10 };
  }

  let maxLevel: RiskLevel = "low";
  for (const factor of factors) {
    maxLevel = getHigherLevel(maxLevel, factor.level);
  }

  return { riskLevel: maxLevel, riskScore: LEVEL_SCORES[maxLevel] };
}

function scoreToLevel(score: number): RiskLevel {
  if (score >= 76) {
    return "critical";
  }
  if (score >= 51) {
    return "high";
  }
  if (score >= 26) {
    return "medium";
  }
  return "low";
}

// -- LLM assessment --

type LlmAssessment = {
  riskScore: number;
  additionalFactors: string[];
  reasoning: string;
};

function buildLlmPrompt(
  decodedFunction: string | null,
  parameters: DecodedParameter[],
  ruleFactors: RiskFactor[],
  context: AssessRiskCoreInput
): string {
  const paramSummary =
    parameters.length > 0
      ? parameters.map((p) => `${p.name} (${p.type}): ${p.value}`).join("\n  ")
      : "No parameters decoded";

  const existingFactors =
    ruleFactors.length > 0
      ? ruleFactors
          .map((f) => `- [${f.level.toUpperCase()}] ${f.description}`)
          .join("\n")
      : "None identified";

  return `You are a DeFi security analyst. Assess this blockchain transaction risk.

Transaction:
  Function: ${decodedFunction ?? "unknown"}
  Parameters:
  ${paramSummary}
  Contract: ${context.contractAddress ?? "unknown"}
  Chain: ${context.chain ?? "unknown"}
  Value: ${context.value ?? "0"} ETH
  Sender: ${context.senderAddress ?? "unknown"}

Pre-identified risks:
${existingFactors}

Respond with ONLY valid JSON (no markdown, no explanation outside JSON):
{"riskScore": <0-100>, "additionalFactors": ["string"], "reasoning": "one sentence"}

Scoring: 0-25 low, 26-50 medium, 51-75 high, 76-100 critical.
Consider: Is this common DeFi? Are values suspicious? Could this be an exploit pattern?`;
}

function parseLlmResponse(text: string): LlmAssessment | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof parsed.riskScore !== "number" ||
      !Array.isArray(parsed.additionalFactors) ||
      typeof parsed.reasoning !== "string"
    ) {
      return null;
    }
    return {
      riskScore: Math.max(0, Math.min(100, parsed.riskScore)),
      additionalFactors: parsed.additionalFactors as string[],
      reasoning: parsed.reasoning,
    };
  } catch {
    return null;
  }
}

async function callLlmAssessment(
  decodedFunction: string | null,
  parameters: DecodedParameter[],
  ruleFactors: RiskFactor[],
  context: AssessRiskCoreInput
): Promise<LlmAssessment | null> {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const prompt = buildLlmPrompt(
      decodedFunction,
      parameters,
      ruleFactors,
      context
    );

    const response = await safeFetch("https://api.openai.com/v1/chat/completions", {
      plugin: "web3",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 200,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      return null;
    }

    return parseLlmResponse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// -- Combine results --

function buildRulesOnlyResult(
  ruleFactors: RiskFactor[],
  ruleAssessment: { riskLevel: RiskLevel; riskScore: number },
  decodedFunction: string | null
): AssessRiskResult {
  return {
    success: true,
    riskLevel: ruleAssessment.riskLevel,
    riskScore: ruleAssessment.riskScore,
    factors: [
      ...ruleFactors.map((f) => f.description),
      "AI analysis unavailable (OPENAI_API_KEY not configured)",
    ],
    decodedFunction,
    reasoning:
      "Assessment based on built-in security rules only. Configure OPENAI_API_KEY for AI-enhanced analysis.",
  };
}

function buildFailClosedResult(
  ruleFactors: RiskFactor[],
  ruleAssessment: { riskLevel: RiskLevel; riskScore: number },
  decodedFunction: string | null
): AssessRiskResult {
  return {
    success: true,
    riskLevel: getHigherLevel(ruleAssessment.riskLevel, "high"),
    riskScore: Math.max(ruleAssessment.riskScore, LEVEL_SCORES.high),
    factors: [
      ...ruleFactors.map((f) => f.description),
      "AI risk analysis failed -- defaulting to elevated risk (fail-closed policy)",
    ],
    decodedFunction,
    reasoning:
      "AI assessment failed or timed out. Risk elevated per fail-closed security policy.",
  };
}

// -- Core logic --

async function stepHandler(
  input: AssessRiskCoreInput
): Promise<AssessRiskResult> {
  const calldata = input.calldata?.trim() ?? "";
  const isNativeTransfer = !calldata || calldata === "0x";

  if (isNativeTransfer) {
    const valueFactors = checkValueRisks(input.value);
    const interactionFactors = checkInteractionRisks(
      input.contractAddress,
      null,
      ""
    );
    const factors = [...valueFactors, ...interactionFactors];
    const assessment = computeRiskFromFactors(factors);

    return {
      success: true,
      riskLevel: assessment.riskLevel,
      riskScore: assessment.riskScore,
      factors:
        factors.length > 0
          ? factors.map((f) => f.description)
          : ["Native ETH transfer with no calldata"],
      decodedFunction: null,
      reasoning: "Native value transfer -- no contract interaction",
    };
  }

  const decodeInput: DecodeCalldataCoreInput = {
    calldata: input.calldata,
    contractAddress: input.contractAddress,
    network: input.chain,
  };

  const decodeResult = await decodeCalldata(decodeInput);

  let functionName: string | null = null;
  let parameters: DecodedParameter[] = [];
  let selector = "";
  let decodedFunction: string | null = null;

  if (decodeResult.success) {
    functionName = decodeResult.functionName;
    parameters = decodeResult.parameters;
    selector = decodeResult.selector;
    decodedFunction =
      decodeResult.functionSignature ?? decodeResult.functionName;
  }

  const ruleFactors: RiskFactor[] = [
    ...checkApprovalRisks(functionName, parameters),
    ...checkPrivilegedOps(functionName),
    ...checkValueRisks(input.value),
    ...checkInteractionRisks(input.contractAddress, functionName, selector),
  ];

  const ruleAssessment = computeRiskFromFactors(ruleFactors);

  if (ruleAssessment.riskLevel === "critical") {
    return {
      success: true,
      riskLevel: "critical",
      riskScore: ruleAssessment.riskScore,
      factors: ruleFactors.map((f) => f.description),
      decodedFunction,
      reasoning: "Critical risk pattern detected by built-in security rules",
    };
  }

  const llmResult = await callLlmAssessment(
    decodedFunction,
    parameters,
    ruleFactors,
    input
  );

  if (llmResult) {
    const llmLevel = scoreToLevel(llmResult.riskScore);
    const combinedLevel = getHigherLevel(ruleAssessment.riskLevel, llmLevel);
    const combinedScore = Math.max(
      ruleAssessment.riskScore,
      llmResult.riskScore
    );

    return {
      success: true,
      riskLevel: combinedLevel,
      riskScore: combinedScore,
      factors: [
        ...ruleFactors.map((f) => f.description),
        ...llmResult.additionalFactors,
      ],
      decodedFunction,
      reasoning: llmResult.reasoning,
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return buildRulesOnlyResult(ruleFactors, ruleAssessment, decodedFunction);
  }

  return buildFailClosedResult(ruleFactors, ruleAssessment, decodedFunction);
}

/**
 * Assess Transaction Risk Step
 * AI-powered risk assessment combining built-in DeFi knowledge base
 * with GPT-4o Mini analysis. Fail-closed: errors elevate risk level.
 */
export async function assessRiskStep(
  input: AssessRiskInput
): Promise<AssessRiskResult> {
  "use step";

  return runPluginStep(
    { pluginName: "web3", actionName: "assess-risk" },
    input,
    stepHandler
  );
}
assessRiskStep.maxRetries = 0;

export const _integrationType = "web3";
