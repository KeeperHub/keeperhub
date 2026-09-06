import "server-only";

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import type { AiGatewayCredentials } from "../credentials";
import {
  type AiGatewayFailure,
  isRecord,
  requestAiGateway,
} from "./ai-gateway-core";

const DEFAULT_TEXT_MODEL = "meta/llama-4-scout";
const SCHEMA_FIELD_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "array",
  "object",
]);
const SCHEMA_ARRAY_ITEM_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "object",
]);

export type SchemaField = {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  itemType?: "string" | "number" | "boolean" | "object";
  fields?: SchemaField[];
  description?: string;
  required?: boolean;
};

export type GenerateTextCoreInput = {
  aiModel?: string;
  aiPrompt?: string;
  aiFormat?: string;
  aiSchema?: string | SchemaField[];
};

export type GenerateTextResult =
  | { success: true; text: string }
  | { success: true; object: Record<string, unknown> }
  | AiGatewayFailure;

type SchemaResult =
  | { success: true; schema: Record<string, unknown> }
  | AiGatewayFailure;

function userFailure(error: string): AiGatewayFailure {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

function normaliseModel(model: string): string {
  if (model.includes("/")) {
    return model;
  }
  if (model.startsWith("claude-")) {
    return `anthropic/${model}`;
  }
  return `openai/${model}`;
}

function parseSchemaFields(value: string | SchemaField[]): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return;
  }
}

function schemaForFields(fields: unknown, location: string): SchemaResult {
  if (!Array.isArray(fields) || fields.length === 0) {
    return userFailure(`${location} must contain at least one field.`);
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const candidate of fields) {
    if (!isRecord(candidate)) {
      return userFailure(`${location} contains an invalid field.`);
    }

    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const type = typeof candidate.type === "string" ? candidate.type : "";
    if (!name) {
      return userFailure(`${location} contains a field without a name.`);
    }
    if (!SCHEMA_FIELD_TYPES.has(type)) {
      return userFailure(`${location}.${name} has an unsupported type.`);
    }
    if (Object.hasOwn(properties, name)) {
      return userFailure(`${location} contains duplicate field "${name}".`);
    }

    const property: Record<string, unknown> = { type };
    if (
      typeof candidate.description === "string" &&
      candidate.description.trim()
    ) {
      property.description = candidate.description.trim();
    }

    if (type === "object") {
      const nested = schemaForFields(candidate.fields, `${location}.${name}`);
      if (!nested.success) {
        return nested;
      }
      Object.assign(property, nested.schema);
    } else if (type === "array") {
      const itemType =
        typeof candidate.itemType === "string" ? candidate.itemType : "";
      if (!SCHEMA_ARRAY_ITEM_TYPES.has(itemType)) {
        return userFailure(
          `${location}.${name} must define a valid array item type.`
        );
      }
      if (itemType === "object") {
        const nested = schemaForFields(
          candidate.fields,
          `${location}.${name}[]`
        );
        if (!nested.success) {
          return nested;
        }
        property.items = nested.schema;
      } else {
        property.items = { type: itemType };
      }
    }

    properties[name] = property;
    if (candidate.required === true) {
      required.push(name);
    }
  }

  const schema: Record<string, unknown> = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) {
    schema.required = required;
  }
  return { success: true, schema };
}

function extractText(data: unknown): string | undefined {
  if (!isRecord(data) || !Array.isArray(data.choices)) {
    return;
  }
  const firstChoice = data.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    return;
  }
  const content = firstChoice.message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return;
  }
  const textParts: string[] = [];
  for (const part of content) {
    if (
      isRecord(part) &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      textParts.push(part.text);
    }
  }
  return textParts.length > 0 ? textParts.join("") : undefined;
}

export async function generateText(
  input: GenerateTextCoreInput,
  credentials: AiGatewayCredentials
): Promise<GenerateTextResult> {
  const apiKey = credentials.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    return userFailure(
      "AI_GATEWAY_API_KEY is not configured. Please add it in Project Integrations."
    );
  }

  const prompt =
    typeof input.aiPrompt === "string" ? input.aiPrompt.trim() : "";
  if (!prompt) {
    return userFailure("Prompt is required for text generation.");
  }

  const model = (input.aiModel ?? DEFAULT_TEXT_MODEL).trim();
  if (!model) {
    return userFailure("Model is required for text generation.");
  }

  const format = input.aiFormat ?? "text";
  if (format !== "text" && format !== "object") {
    return userFailure('Output format must be either "text" or "object".');
  }

  const body: Record<string, unknown> = {
    model: normaliseModel(model),
    messages: [{ role: "user", content: prompt }],
  };

  if (format === "object") {
    if (input.aiSchema === undefined || input.aiSchema === "") {
      return userFailure("Schema is required for object output.");
    }
    const schema = schemaForFields(parseSchemaFields(input.aiSchema), "Schema");
    if (!schema.success) {
      return schema;
    }
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema: schema.schema },
    };
  }

  const response = await requestAiGateway("/chat/completions", apiKey, body);
  if (!response.success) {
    return response;
  }

  const text = extractText(response.data);
  if (text === undefined) {
    return {
      success: false,
      error: "AI Gateway returned a malformed text-generation response.",
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }

  if (format === "object") {
    try {
      const object = JSON.parse(text) as unknown;
      if (!isRecord(object)) {
        return {
          success: false,
          error: "AI Gateway returned structured output that is not an object.",
          errorClass: ExecutionErrorType.EXTERNAL,
        };
      }
      return { success: true, object };
    } catch {
      return {
        success: false,
        error: "AI Gateway returned invalid JSON for structured output.",
        errorClass: ExecutionErrorType.EXTERNAL,
      };
    }
  }

  return { success: true, text };
}
