// Caps prompt and existing-workflow size so an authenticated caller cannot
// burn the OpenAI/Anthropic bill by submitting massive inputs. The
// rate limiter (see ./rate-limit) bounds frequency; these caps bound
// per-request cost.

export const MAX_PROMPT_LENGTH = 50_000;
export const MAX_WORKFLOW_JSON_LENGTH = 100_000;

// Loose shape: the route reads .nodes / .edges and JSON-stringifies the whole
// object back into the model context. The validator does not enforce the
// inner array element shape; downstream callers narrow as needed.
export type ExistingWorkflowInput = {
  nodes?: { id: string; data?: { label?: string } }[];
  edges?: { id: string; source: string; target: string }[];
} & Record<string, unknown>;

export type GenerateBodyValidation =
  | {
      ok: true;
      prompt: string;
      existingWorkflow: ExistingWorkflowInput | null;
    }
  | { ok: false; error: string; status: number };

export function validateGenerateBody(body: unknown): GenerateBodyValidation {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Invalid request body", status: 400 };
  }

  const { prompt, existingWorkflow } = body as {
    prompt?: unknown;
    existingWorkflow?: unknown;
  };

  if (typeof prompt !== "string" || prompt.length === 0) {
    return { ok: false, error: "Prompt is required", status: 400 };
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      error: `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`,
      status: 413,
    };
  }

  if (existingWorkflow === undefined || existingWorkflow === null) {
    return { ok: true, prompt, existingWorkflow: null };
  }

  if (typeof existingWorkflow !== "object") {
    return {
      ok: false,
      error: "existingWorkflow must be an object",
      status: 400,
    };
  }

  let serializedLength: number;
  try {
    serializedLength = JSON.stringify(existingWorkflow).length;
  } catch {
    return {
      ok: false,
      error: "existingWorkflow is not serializable",
      status: 400,
    };
  }
  if (serializedLength > MAX_WORKFLOW_JSON_LENGTH) {
    return {
      ok: false,
      error: `existingWorkflow exceeds maximum size of ${MAX_WORKFLOW_JSON_LENGTH} characters when serialized`,
      status: 413,
    };
  }

  return {
    ok: true,
    prompt,
    existingWorkflow: existingWorkflow as ExistingWorkflowInput,
  };
}
