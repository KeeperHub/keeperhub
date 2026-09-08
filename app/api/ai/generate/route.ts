import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { streamText } from "ai";
import { NextResponse } from "next/server";
import { HttpStatus } from "@/lib/http-status";
import { ErrorCategory, logSystemError, logWarn } from "@/lib/logging";
import { SCOPE_MCP_WRITE } from "@/lib/mcp/oauth-scopes";
import { createTimer, getMetricsCollector } from "@/lib/metrics";
import { MetricNames } from "@/lib/metrics/types";
import { getDualAuthContext } from "@/lib/middleware/auth-helpers";
import { requireScope } from "@/lib/middleware/require-scope";
import { applyRateLimitHeaders } from "@/lib/rate-limit-headers";
import { generateAIActionPrompts } from "@/plugins/registry";
import {
  checkAiGenerateRateLimit,
  getAiGenerateRateLimitKey,
} from "../_lib/rate-limit";
import { validateGenerateBody } from "../_lib/validate";

// Simple type for operations
type Operation = {
  op:
    | "setName"
    | "setDescription"
    | "addNode"
    | "addEdge"
    | "removeNode"
    | "removeEdge"
    | "updateNode";
  name?: string;
  description?: string;
  node?: unknown;
  edge?: unknown;
  nodeId?: string;
  edgeId?: string;
  updates?: {
    position?: { x: number; y: number };
    data?: unknown;
  };
};

function encodeMessage(encoder: TextEncoder, message: object): Uint8Array {
  return encoder.encode(`${JSON.stringify(message)}\n`);
}

function shouldSkipLine(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed || trimmed.startsWith("```");
}

function tryParseAndEnqueueOperation(
  line: string,
  encoder: TextEncoder,
  controller: ReadableStreamDefaultController,
  operationCount: number
): number {
  const trimmed = line.trim();

  if (shouldSkipLine(line)) {
    return operationCount;
  }

  try {
    const operation = JSON.parse(trimmed) as Operation;
    const newCount = operationCount + 1;

    console.log(`[API] Operation ${newCount}:`, operation.op);

    controller.enqueue(
      encodeMessage(encoder, {
        type: "operation",
        operation,
      })
    );

    return newCount;
  } catch {
    logWarn("[API] Skipping invalid JSON line", {
      line_preview: trimmed.substring(0, 50),
    });
    return operationCount;
  }
}

function processBufferLines(
  buffer: string,
  encoder: TextEncoder,
  controller: ReadableStreamDefaultController,
  operationCount: number
): { remainingBuffer: string; newOperationCount: number } {
  const lines = buffer.split("\n");
  const remainingBuffer = lines.pop() || "";
  let newOperationCount = operationCount;

  for (const line of lines) {
    newOperationCount = tryParseAndEnqueueOperation(
      line,
      encoder,
      controller,
      newOperationCount
    );
  }

  return { remainingBuffer, newOperationCount };
}

async function processOperationStream(
  textStream: AsyncIterable<string>,
  encoder: TextEncoder,
  controller: ReadableStreamDefaultController
): Promise<void> {
  let buffer = "";
  let operationCount = 0;
  let chunkCount = 0;

  for await (const chunk of textStream) {
    chunkCount += 1;
    buffer += chunk;

    const result = processBufferLines(
      buffer,
      encoder,
      controller,
      operationCount
    );
    buffer = result.remainingBuffer;
    operationCount = result.newOperationCount;
  }

  // Process any remaining buffer content
  operationCount = tryParseAndEnqueueOperation(
    buffer,
    encoder,
    controller,
    operationCount
  );

  console.log(
    `[API] Stream complete. Chunks: ${chunkCount}, Operations: ${operationCount}`
  );

  // Send completion
  controller.enqueue(
    encodeMessage(encoder, {
      type: "complete",
    })
  );
}

function getSystemPrompt(): string {
  const pluginActionPrompts = generateAIActionPrompts();
  return `You are a workflow automation expert. Generate a workflow based on the user's description.

CRITICAL: Output your workflow as INDIVIDUAL OPERATIONS, one per line in JSONL format.
Each line must be a complete, separate JSON object.

Operations you can output:
1. {"op": "setName", "name": "Workflow Name"}
2. {"op": "setDescription", "description": "Brief description"}
3. {"op": "addNode", "node": {COMPLETE_NODE_OBJECT}}
4. {"op": "addEdge", "edge": {COMPLETE_EDGE_OBJECT}}
5. {"op": "removeNode", "nodeId": "node-id-to-remove"}
6. {"op": "removeEdge", "edgeId": "edge-id-to-remove"}
7. {"op": "updateNode", "nodeId": "node-id", "updates": {"position": {"x": 100, "y": 200}}}

IMPORTANT RULES:
- Every workflow must have EXACTLY ONE trigger node
- Output ONE operation per line
- Each line must be complete, valid JSON
- Start with setName and setDescription
- Then add nodes one at a time
- Finally add edges one at a time to CONNECT ALL NODES
- CRITICAL: Every node (except the last) MUST be connected to at least one other node
- To update node positions or properties, use updateNode operation
- NEVER output explanatory text - ONLY JSON operations
- Do NOT wrap in markdown code blocks
- Do NOT add explanatory text

Node structure:
{
  "id": "unique-id",
  "type": "trigger" or "action",
  "position": {"x": number, "y": number},
  "data": {
    "label": "Node Label",
    "description": "Node description",
    "type": "trigger" or "action",
    "config": {...},
    "status": "idle"
  }
}

NODE POSITIONING RULES:
- Nodes are squares, so use equal spacing in both directions
- Horizontal spacing between sequential nodes: 250px (e.g., x: 100, then x: 350, then x: 600)
- Vertical spacing for parallel branches: 250px (e.g., y: 75, y: 325, y: 575)
- Start trigger node at position {"x": 100, "y": 200}
- For linear workflows: increment x by 250 for each subsequent node, keep y constant
- For branching workflows: keep x the same for parallel branches, space y by 250px per branch
- When adding nodes to existing workflows, position new nodes 250px away from existing nodes

Trigger types:
- Manual: {"triggerType": "Manual"}
- Webhook: {"triggerType": "Webhook", "webhookPath": "/webhooks/name", ...}
- Schedule: {"triggerType": "Schedule", "scheduleCron": "0 9 * * *", ...}

System action types (built-in):
- Database Query: {"actionType": "Database Query", "dbQuery": "SELECT * FROM table", "dbTable": "table"}
- HTTP Request: {"actionType": "HTTP Request", "httpMethod": "POST", "endpoint": "https://api.example.com", "httpHeaders": "{}", "httpBody": "{}"}
- Condition: {"actionType": "Condition", "condition": "{{@nodeId:Label.field}} === 'value'"}

Plugin action types (from integrations):
${pluginActionPrompts}

CRITICAL ABOUT CONDITION NODES:
- Condition nodes evaluate a boolean expression
- When TRUE: ALL connected nodes execute
- When FALSE: ALL connected nodes are SKIPPED
- For if/else logic, CREATE MULTIPLE SEPARATE condition nodes (one per branch)
- NEVER connect multiple different outcome paths to a single condition node
- Each condition should check for ONE specific case

Example: "if good send Slack, if bad create ticket" needs TWO conditions:
{"op": "addNode", "node": {"id": "cond-good", "data": {"config": {"condition": "{{@rate:Rate.value}} === 'good'"}}}}
{"op": "addNode", "node": {"id": "cond-bad", "data": {"config": {"condition": "{{@rate:Rate.value}} === 'bad'"}}}}
{"op": "addEdge", "edge": {"source": "rate", "target": "cond-good"}}
{"op": "addEdge", "edge": {"source": "rate", "target": "cond-bad"}}
{"op": "addEdge", "edge": {"source": "cond-good", "target": "slack"}}
{"op": "addEdge", "edge": {"source": "cond-bad", "target": "ticket"}}

Edge structure:
{
  "id": "edge-id",
  "source": "source-node-id",
  "target": "target-node-id",
  "type": "default"
}

WORKFLOW FLOW:
- Trigger connects to first action
- Actions connect in sequence or to multiple branches
- ALWAYS create edges to connect the workflow flow
- For linear workflows: trigger -> action1 -> action2 -> etc
- For branching (conditions): one source can connect to multiple targets

Example output (linear workflow with 250px horizontal spacing):
{"op": "setName", "name": "Contact Form Workflow"}
{"op": "setDescription", "description": "Processes contact form submissions"}
{"op": "addNode", "node": {"id": "trigger-1", "type": "trigger", "position": {"x": 100, "y": 200}, "data": {"label": "Contact Form", "type": "trigger", "config": {"triggerType": "Manual"}, "status": "idle"}}}
{"op": "addNode", "node": {"id": "send-email", "type": "action", "position": {"x": 350, "y": 200}, "data": {"label": "Send Email", "type": "action", "config": {"actionType": "Send Email", "emailTo": "admin@example.com", "emailSubject": "New Contact", "emailBody": "New contact form submission"}, "status": "idle"}}}
{"op": "addNode", "node": {"id": "log-action", "type": "action", "position": {"x": 600, "y": 200}, "data": {"label": "Log Result", "type": "action", "config": {"actionType": "HTTP Request", "httpMethod": "POST", "endpoint": "https://api.example.com/log"}, "status": "idle"}}}
{"op": "addEdge", "edge": {"id": "e1", "source": "trigger-1", "target": "send-email", "type": "default"}}
{"op": "addEdge", "edge": {"id": "e2", "source": "send-email", "target": "log-action", "type": "default"}}

Example output (branching workflow with 250px vertical spacing):
{"op": "addNode", "node": {"id": "trigger-1", "type": "trigger", "position": {"x": 100, "y": 200}, "data": {"label": "Webhook", "type": "trigger", "config": {"triggerType": "Webhook"}, "status": "idle"}}}
{"op": "addNode", "node": {"id": "branch-a", "type": "action", "position": {"x": 350, "y": 75}, "data": {"label": "Branch A", "type": "action", "config": {"actionType": "Send Email"}, "status": "idle"}}}
{"op": "addNode", "node": {"id": "branch-b", "type": "action", "position": {"x": 350, "y": 325}, "data": {"label": "Branch B", "type": "action", "config": {"actionType": "Send Slack Message"}, "status": "idle"}}}
{"op": "addEdge", "edge": {"id": "e1", "source": "trigger-1", "target": "branch-a", "type": "default"}}
{"op": "addEdge", "edge": {"id": "e2", "source": "trigger-1", "target": "branch-b", "type": "default"}}

REMEMBER: After adding all nodes, you MUST add edges to connect them! Every node should be reachable from the trigger.`;
}

function getAIModel(
  modelString: string,
  aiGatewayKey: string | undefined,
  openaiKey: string | undefined,
  anthropicKey: string | undefined
):
  | { success: true; model: LanguageModelV2 | string }
  | { success: false; error: string } {
  // AI Gateway mode - model has provider prefix (e.g., "openai/gpt-4")
  if (modelString.includes("/")) {
    if (!aiGatewayKey) {
      return {
        success: false,
        error:
          "AI Gateway API key not configured. Set AI_GATEWAY_API_KEY environment variable.",
      };
    }
    // Use model string directly - AI SDK will route through gateway
    return { success: true, model: modelString };
  }

  // Direct provider mode - determine provider from model name
  if (modelString.startsWith("gpt-") || modelString.startsWith("o1-")) {
    if (!openaiKey) {
      return {
        success: false,
        error:
          "OpenAI API key not configured. Set OPENAI_API_KEY environment variable.",
      };
    }
    const provider = createOpenAI({ apiKey: openaiKey });
    return { success: true, model: provider(modelString) };
  }

  if (modelString.startsWith("claude-")) {
    if (!anthropicKey) {
      return {
        success: false,
        error:
          "Anthropic API key not configured. Set ANTHROPIC_API_KEY environment variable.",
      };
    }
    const provider = createAnthropic({ apiKey: anthropicKey });
    return {
      success: true,
      model: provider(modelString),
    };
  }

  // Default to OpenAI for unknown models
  if (!openaiKey) {
    return {
      success: false,
      error:
        "OpenAI API key not configured. Set OPENAI_API_KEY environment variable.",
    };
  }
  const provider = createOpenAI({ apiKey: openaiKey });
  return { success: true, model: provider(modelString) };
}

export async function POST(request: Request) {
  // Feature flag gate. Defense-in-depth alongside the UI gate in
  // components/workflow/workflow-canvas.tsx so direct API callers cannot
  // bypass the disabled prompt.
  if (process.env.NEXT_PUBLIC_AI_PROMPT_ENABLED !== "true") {
    return NextResponse.json(
      { error: "AI Prompt is disabled" },
      { status: HttpStatus.SERVICE_UNAVAILABLE }
    );
  }

  const timer = createTimer();
  const metrics = getMetricsCollector();

  try {
    const authContext = await getDualAuthContext(request);
    if ("error" in authContext) {
      metrics.recordLatency(MetricNames.AI_GENERATION_DURATION, timer(), {
        status: "failure",
      });
      return NextResponse.json(
        { error: authContext.error },
        { status: authContext.status }
      );
    }

    const scopeError = requireScope(authContext.scope, SCOPE_MCP_WRITE, {
      credentialType: authContext.authMethod,
    });
    if (scopeError) {
      return scopeError;
    }

    const rateLimit = checkAiGenerateRateLimit(
      getAiGenerateRateLimitKey(authContext)
    );
    if (!rateLimit.allowed) {
      return applyRateLimitHeaders(
        NextResponse.json(
          { error: "Rate limit exceeded" },
          { status: HttpStatus.TOO_MANY_REQUESTS }
        ),
        rateLimit
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: HttpStatus.BAD_REQUEST }
      );
    }

    const validation = validateGenerateBody(rawBody);
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }
    const { prompt, existingWorkflow } = validation;

    // Determine which AI provider and model to use
    const modelString = process.env.AI_MODEL || "gpt-4o";
    const modelResult = getAIModel(
      modelString,
      process.env.AI_GATEWAY_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.ANTHROPIC_API_KEY
    );

    if (!modelResult.success) {
      metrics.recordLatency(MetricNames.AI_GENERATION_DURATION, timer(), {
        status: "failure",
      });
      return NextResponse.json(
        { error: modelResult.error },
        { status: HttpStatus.INTERNAL_SERVER_ERROR }
      );
    }

    const model = modelResult.model;

    // Build the user prompt
    let userPrompt = prompt;
    if (existingWorkflow) {
      // Identify nodes and their labels for context
      const nodesList = (existingWorkflow.nodes || [])
        .map(
          (n: { id: string; data?: { label?: string } }) =>
            `- ${n.id} (${n.data?.label || "Unlabeled"})`
        )
        .join("\n");

      const edgesList = (existingWorkflow.edges || [])
        .map(
          (e: { id: string; source: string; target: string }) =>
            `- ${e.id}: ${e.source} -> ${e.target}`
        )
        .join("\n");

      userPrompt = `I have an existing workflow. I want you to make ONLY the changes I request.

Current workflow nodes:
${nodesList}

Current workflow edges:
${edgesList}

Full workflow data (DO NOT recreate these, they already exist):
${JSON.stringify(existingWorkflow, null, 2)}

User's request: ${prompt}

IMPORTANT: Output ONLY the operations needed to make the requested changes.
- If adding new nodes: output "addNode" operations for NEW nodes only, then IMMEDIATELY output "addEdge" operations to connect them to the workflow
- If adding new edges: output "addEdge" operations for NEW edges only  
- If removing nodes: output "removeNode" operations with the nodeId to remove
- If removing edges: output "removeEdge" operations with the edgeId to remove
- If changing name/description: output "setName"/"setDescription" only if changed
- CRITICAL: New nodes MUST be connected with edges - always add edges after adding nodes
- When connecting nodes, look at the node IDs in the current workflow list above
- DO NOT output operations for existing nodes/edges unless specifically modifying them
- Keep the existing workflow structure and only add/modify/remove what was requested
- POSITIONING: When adding new nodes, look at existing node positions and place new nodes 250px away (horizontally or vertically) from existing nodes. Never overlap nodes.

Example: If user says "connect node A to node B", output:
{"op": "addEdge", "edge": {"id": "e-new", "source": "A", "target": "B", "type": "default"}}`;
    }

    const result = streamText({
      model,
      system: getSystemPrompt(),
      prompt: userPrompt,
    });

    // Create a streaming response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          await processOperationStream(result.textStream, encoder, controller);
          metrics.recordLatency(MetricNames.AI_GENERATION_DURATION, timer(), {
            status: "success",
          });
          controller.close();
        } catch (error) {
          metrics.recordLatency(MetricNames.AI_GENERATION_DURATION, timer(), {
            status: "failure",
          });
          controller.enqueue(
            encodeMessage(encoder, {
              type: "error",
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to generate workflow",
            })
          );
          controller.close();
        }
      },
    });

    return applyRateLimitHeaders(
      new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      rateLimit
    );
  } catch (error) {
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      "Failed to generate workflow",
      error,
      { endpoint: "/api/ai/generate", operation: "generateWorkflow" }
    );
    metrics.recordLatency(MetricNames.AI_GENERATION_DURATION, timer(), {
      status: "failure",
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to generate workflow",
      },
      { status: HttpStatus.INTERNAL_SERVER_ERROR }
    );
  }
}
