import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_LENGTH,
  MAX_WORKFLOW_JSON_LENGTH,
  validateGenerateBody,
} from "@/app/api/ai/_lib/validate";

const PROMPT_REQUIRED_RE = /prompt is required/i;
const MAX_LENGTH_RE = /maximum length/i;
const EXISTING_WORKFLOW_RE = /existingWorkflow/;
const SERIALIZABLE_RE = /serializable/;

describe("validateGenerateBody", () => {
  it("rejects null body", () => {
    const result = validateGenerateBody(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it("rejects missing prompt", () => {
    const result = validateGenerateBody({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(PROMPT_REQUIRED_RE);
    }
  });

  it("rejects empty-string prompt", () => {
    const result = validateGenerateBody({ prompt: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects non-string prompt", () => {
    const result = validateGenerateBody({ prompt: 123 });
    expect(result.ok).toBe(false);
  });

  it("accepts a prompt at the max length boundary", () => {
    const result = validateGenerateBody({
      prompt: "a".repeat(MAX_PROMPT_LENGTH),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a prompt one character over the max length", () => {
    const result = validateGenerateBody({
      prompt: "a".repeat(MAX_PROMPT_LENGTH + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
      expect(result.error).toMatch(MAX_LENGTH_RE);
    }
  });

  it("accepts a small existingWorkflow", () => {
    const result = validateGenerateBody({
      prompt: "build a workflow",
      existingWorkflow: { nodes: [], edges: [] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.existingWorkflow).toEqual({ nodes: [], edges: [] });
    }
  });

  it("returns null for missing existingWorkflow", () => {
    const result = validateGenerateBody({ prompt: "hi" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.existingWorkflow).toBeNull();
    }
  });

  it("rejects existingWorkflow that serializes over the cap", () => {
    // A node with a description longer than the cap forces serialized length
    // past the limit even after JSON's quoting overhead.
    const huge = "x".repeat(MAX_WORKFLOW_JSON_LENGTH + 100);
    const result = validateGenerateBody({
      prompt: "hi",
      existingWorkflow: { nodes: [{ id: "n1", data: { label: huge } }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
      expect(result.error).toMatch(EXISTING_WORKFLOW_RE);
    }
  });

  it("rejects circular existingWorkflow", () => {
    const cyclic: Record<string, unknown> = { nodes: [] };
    cyclic.self = cyclic;
    const result = validateGenerateBody({
      prompt: "hi",
      existingWorkflow: cyclic,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(SERIALIZABLE_RE);
    }
  });

  it("rejects non-object existingWorkflow", () => {
    const result = validateGenerateBody({
      prompt: "hi",
      existingWorkflow: "not an object",
    });
    expect(result.ok).toBe(false);
  });
});
