import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

const { fetchCredentials } = vi.hoisted(() => ({
  fetchCredentials: vi.fn(),
}));
vi.mock("@/lib/credential-fetcher", () => ({ fetchCredentials }));

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { generateImageStep } from "@/plugins/ai-gateway/steps/generate-image";
import { generateTextStep } from "@/plugins/ai-gateway/steps/generate-text";

function mockGatewayResponse(
  body: unknown,
  options?: { ok?: boolean; status?: number }
): void {
  safeFetch.mockResolvedValueOnce({
    ok: options?.ok ?? true,
    status: options?.status ?? 200,
    json: vi.fn().mockResolvedValue(body),
  });
}

function requestBody(callIndex = 0): Record<string, unknown> {
  const options = safeFetch.mock.calls[callIndex]?.[1] as
    | { body?: string }
    | undefined;
  return JSON.parse(options?.body ?? "{}") as Record<string, unknown>;
}

describe("AI Gateway generate text", () => {
  beforeEach(() => {
    fetchCredentials.mockReset();
    safeFetch.mockReset();
    fetchCredentials.mockResolvedValue({ AI_GATEWAY_API_KEY: "gateway-key" });
  });

  it("fetches BYOK credentials in the organization context and sends the Gateway request", async () => {
    mockGatewayResponse({
      choices: [{ message: { content: "Generated response" } }],
    });

    const result = await generateTextStep({
      integrationId: "integration-1",
      aiModel: "anthropic/claude-sonnet-4.5",
      aiPrompt: "Write a summary",
      aiFormat: "text",
      _context: {
        organizationId: "organization-1",
        nodeId: "node-1",
        nodeName: "Generate Text",
        nodeType: "ai-gateway/generate-text",
      },
    });

    expect(result).toEqual({ success: true, text: "Generated response" });
    expect(fetchCredentials).toHaveBeenCalledWith("integration-1", {
      organizationId: "organization-1",
    });
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch).toHaveBeenCalledWith(
      "https://ai-gateway.vercel.sh/v1/chat/completions",
      expect.objectContaining({
        plugin: "ai-gateway",
        method: "POST",
        headers: {
          Authorization: "Bearer gateway-key",
          "Content-Type": "application/json",
        },
      })
    );
    expect(requestBody()).toEqual({
      model: "anthropic/claude-sonnet-4.5",
      messages: [{ role: "user", content: "Write a summary" }],
    });
  });

  it("requests and parses structured object output", async () => {
    mockGatewayResponse({
      choices: [{ message: { content: '{"title":"KeeperHub"}' } }],
    });

    const result = await generateTextStep({
      integrationId: "integration-1",
      aiPrompt: "Return a title",
      aiFormat: "object",
      aiSchema: JSON.stringify([
        {
          name: "title",
          type: "string",
          description: "The title",
          required: true,
        },
      ]),
    });

    expect(result).toEqual({
      success: true,
      object: { title: "KeeperHub" },
    });
    expect(requestBody()).toEqual({
      model: "meta/llama-4-scout",
      messages: [{ role: "user", content: "Return a title" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: {
            type: "object",
            properties: {
              title: { type: "string", description: "The title" },
            },
            additionalProperties: false,
            required: ["title"],
          },
        },
      },
    });
  });

  it("returns provider errors without throwing", async () => {
    mockGatewayResponse(
      { error: { message: "Model is unavailable" } },
      { ok: false, status: 503 }
    );

    const result = await generateTextStep({
      integrationId: "integration-1",
      aiPrompt: "Hello",
    });

    expect(result).toEqual({
      success: false,
      error: "Model is unavailable",
      errorClass: ExecutionErrorType.EXTERNAL,
    });
  });

  it("returns a typed failure for a malformed success response", async () => {
    mockGatewayResponse({ choices: [] });

    const result = await generateTextStep({
      integrationId: "integration-1",
      aiPrompt: "Hello",
    });

    expect(result).toEqual({
      success: false,
      error: "AI Gateway returned a malformed text-generation response.",
      errorClass: ExecutionErrorType.EXTERNAL,
    });
  });

  it("validates format and schema before egress", async () => {
    const invalidFormat = await generateTextStep({
      integrationId: "integration-1",
      aiPrompt: "Hello",
      aiFormat: "xml",
    });
    const missingSchema = await generateTextStep({
      integrationId: "integration-1",
      aiPrompt: "Hello",
      aiFormat: "object",
    });

    expect(invalidFormat).toEqual({
      success: false,
      error: 'Output format must be either "text" or "object".',
      errorClass: ExecutionErrorType.USER,
    });
    expect(missingSchema).toEqual({
      success: false,
      error: "Schema is required for object output.",
      errorClass: ExecutionErrorType.USER,
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("validates prompt and model before egress", async () => {
    const missingPrompt = await generateTextStep({
      integrationId: "integration-1",
      aiPrompt: " ",
    });
    const missingModel = await generateTextStep({
      integrationId: "integration-1",
      aiPrompt: "Hello",
      aiModel: "",
    });

    expect(missingPrompt).toEqual({
      success: false,
      error: "Prompt is required for text generation.",
      errorClass: ExecutionErrorType.USER,
    });
    expect(missingModel).toEqual({
      success: false,
      error: "Model is required for text generation.",
      errorClass: ExecutionErrorType.USER,
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe("AI Gateway generate image", () => {
  beforeEach(() => {
    fetchCredentials.mockReset();
    safeFetch.mockReset();
    fetchCredentials.mockResolvedValue({ AI_GATEWAY_API_KEY: "gateway-key" });
  });

  it("returns base64 and sends the intended image request shape", async () => {
    mockGatewayResponse({ data: [{ b64_json: "aW1hZ2U=" }] });

    const result = await generateImageStep({
      integrationId: "integration-1",
      imageModel: "google/imagen-4.0-fast-generate-001",
      imagePrompt: "A mountain at sunset",
    });

    expect(result).toEqual({ success: true, base64: "aW1hZ2U=" });
    expect(safeFetch).toHaveBeenCalledWith(
      "https://ai-gateway.vercel.sh/v1/images/generations",
      expect.objectContaining({ plugin: "ai-gateway", method: "POST" })
    );
    expect(requestBody()).toEqual({
      model: "google/imagen-4.0-fast-generate-001",
      prompt: "A mountain at sunset",
      size: "1024x1024",
      response_format: "b64_json",
    });
  });

  it("returns a typed user failure for a provider rejection", async () => {
    mockGatewayResponse(
      { error: { message: "Unsupported image model" } },
      { ok: false, status: 400 }
    );

    const result = await generateImageStep({
      integrationId: "integration-1",
      imagePrompt: "A mountain",
    });

    expect(result).toEqual({
      success: false,
      error: "Unsupported image model",
      errorClass: ExecutionErrorType.USER,
    });
  });

  it("returns a typed failure for a malformed success response", async () => {
    mockGatewayResponse({ data: [{ url: "https://example.com/image.png" }] });

    const result = await generateImageStep({
      integrationId: "integration-1",
      imagePrompt: "A mountain",
    });

    expect(result).toEqual({
      success: false,
      error: "AI Gateway returned a malformed image-generation response.",
      errorClass: ExecutionErrorType.EXTERNAL,
    });
  });

  it("validates prompt and model before egress", async () => {
    const missingPrompt = await generateImageStep({
      integrationId: "integration-1",
      imagePrompt: " ",
    });
    const missingModel = await generateImageStep({
      integrationId: "integration-1",
      imagePrompt: "A mountain",
      imageModel: "",
    });

    expect(missingPrompt).toEqual({
      success: false,
      error: "Prompt is required for image generation.",
      errorClass: ExecutionErrorType.USER,
    });
    expect(missingModel).toEqual({
      success: false,
      error: "Model is required for image generation.",
      errorClass: ExecutionErrorType.USER,
    });
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
