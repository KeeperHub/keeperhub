import { isSafeConditionExpression } from "@/lib/workflow/nodes/condition/safe-eval";
import { maskStringLiterals } from "@/lib/workflow/nodes/condition/string-literal";
import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow/store";
import {
  findTemplateTokens,
  replaceTemplateTokens,
} from "@/lib/workflow/template-ref";
import { findActionById } from "@/plugins/registry";

// Regex patterns at top level for performance
export const WHITESPACE_PATTERN = /\s+/;
export const NON_ALPHANUMERIC_PATTERN = /[^a-zA-Z0-9]/g;
export const VALID_IDENTIFIER_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
export const NUMBER_START_PATTERN = /^[0-9]/;

/**
 * Helper to find all node references in templates
 */
export function findNodeReferences(template: string): Set<string> {
  const refs = new Set<string>();
  if (!template || typeof template !== "string") {
    return refs;
  }

  for (const token of findTemplateTokens(template)) {
    const expression = token.body.trim();

    // Handle @nodeId:DisplayName.field format
    if (expression.startsWith("@")) {
      const withoutAt = expression.substring(1);
      const colonIndex = withoutAt.indexOf(":");
      if (colonIndex !== -1) {
        const nodeId = withoutAt.substring(0, colonIndex);
        refs.add(nodeId);
      }
    }
    // Handle $nodeId.field format
    else if (expression.startsWith("$")) {
      const withoutDollar = expression.substring(1);
      const parts = withoutDollar.split(".");
      if (parts.length > 0) {
        refs.add(parts[0]);
      }
    }
  }

  return refs;
}

/**
 * Helper to extract node references from a config value
 */
export function extractRefsFromConfigValue(value: unknown): Set<string> {
  const refs = new Set<string>();
  if (typeof value === "string") {
    const foundRefs = findNodeReferences(value);
    for (const ref of foundRefs) {
      refs.add(ref);
    }
  }
  return refs;
}

/**
 * Helper to analyze which node outputs are used
 */
export function analyzeNodeUsage(nodes: WorkflowNode[]): Set<string> {
  const usedNodes = new Set<string>();

  for (const node of nodes) {
    if (node.data.type !== "action") {
      continue;
    }

    const config = node.data.config || {};
    for (const value of Object.values(config)) {
      const refs = extractRefsFromConfigValue(value);
      for (const ref of refs) {
        usedNodes.add(ref);
      }
    }
  }

  return usedNodes;
}

/**
 * Build a map of node connections
 */
export function buildEdgeMap(edges: WorkflowEdge[]): Map<string, string[]> {
  const edgesBySource = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = edgesBySource.get(edge.source) || [];
    targets.push(edge.target);
    edgesBySource.set(edge.source, targets);
  }
  return edgesBySource;
}

/**
 * Find trigger nodes (nodes with no incoming edges)
 */
export function findTriggerNodes(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowNode[] {
  const nodesWithIncoming = new Set(edges.map((e) => e.target));
  return nodes.filter(
    (node) => node.data.type === "trigger" && !nodesWithIncoming.has(node.id)
  );
}

const IDENTIFIER_PART = /^[A-Za-z_$][\w$]*$/;
// An index written as a number literal: no leading zero, exact as a double.
const CANONICAL_INDEX = /^(?:0|[1-9]\d{0,14})$/;
// key[index], read the way the run reads a path part (resolveStrictPath).
const INDEXED_PART = /^([^[]+)\[(\d+)\]$/;

// Exporters escape some output again after conversion; a key with no
// backslash or backtick passes through that unchanged. Code written as is
// (a Condition's test) keeps the plain quoted key.
function quotedKey(key: string, writtenAsIs: boolean): string {
  const json = JSON.stringify(key);
  if (writtenAsIs || !(json.includes("\\") || key.includes("`"))) {
    return json;
  }
  const codes = Array.from({ length: key.length }, (_, i) => key.charCodeAt(i));
  return `String.fromCharCode(${codes.join(",")})`;
}

type AccessPathOptions = { optional?: boolean; writtenAsIs?: boolean };

function keyAccess(key: string, options: AccessPathOptions): string {
  const optional = options.optional ?? false;
  if (IDENTIFIER_PART.test(key)) {
    return `${optional ? "?." : "."}${key}`;
  }
  const open = optional ? "?.[" : "[";
  return CANONICAL_INDEX.test(key)
    ? `${open}${key}]`
    : `${open}${quotedKey(key, options.writtenAsIs ?? false)}]`;
}

/**
 * A field path as code, read the way the run reads it: parts trimmed, empty
 * parts skipped, key[n] as an index. Any key that is not a plain name or
 * index is written as data, so no saved path can become code. `optional`
 * writes ?. and ?.[ instead.
 */
export function buildAccessPath(
  fieldPath: string,
  options: AccessPathOptions = {}
): string {
  const open = options.optional ? "?.[" : "[";
  let path = "";
  for (const raw of fieldPath.split(".")) {
    const part = raw.trim();
    if (!part) {
      continue;
    }
    const indexed = INDEXED_PART.exec(part);
    if (indexed) {
      const index = String(Number.parseInt(indexed[2], 10));
      path += `${keyAccess(indexed[1], options)}${open}${index}]`;
    } else {
      path += keyAccess(part, options);
    }
  }
  return path;
}

/**
 * Helper to convert label or action type to a friendly variable name
 */
export function toFriendlyVarName(label: string, actionType?: string): string {
  // Use label if available, otherwise fall back to action type
  const baseName = label || actionType || "result";

  // Convert to camelCase: "Generate Friendly Greeting Email" -> "generateFriendlyGreetingEmail"
  const camelCase = baseName
    .split(WHITESPACE_PATTERN)
    .map((word, index) => {
      const cleaned = word.replace(NON_ALPHANUMERIC_PATTERN, "");
      if (!cleaned) {
        return "";
      }
      if (index === 0) {
        return cleaned.toLowerCase();
      }
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
    })
    .filter((word) => word.length > 0)
    .join("");

  // Add "Result" suffix
  return `${camelCase}Result`;
}

/**
 * Helper to remove invisible characters (non-breaking spaces, etc.)
 */
export function removeInvisibleChars(str: string): string {
  // Replace non-breaking space (U+00a0) and other invisible spaces with regular space
  return str
    .replace(/\u00a0/g, " ") // Non-breaking space
    .replace(/[\u2000-\u200B\u2028\u2029]/g, " "); // Various invisible space characters
}

/** Text that cannot end or break out of a // or /* comment. */
export function commentSafe(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\*\//g, "*\\/");
}

/** Literal text for a template literal, escaped before references become ${...}. */
function escapeTemplateText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

/**
 * For a condition written inside a template literal: the run's grammar, with
 * each reference the exporter resolves read as a variable. A token it cannot
 * resolve stays as typed and fails the check. Callers handle matchesRegex.
 */
export function isExportableCondition(
  condition: string,
  resolves: (tokenBody: string) => boolean
): boolean {
  return isSafeConditionExpression(
    replaceTemplateTokens(condition, ({ body }) =>
      resolves(body) ? "__v0" : `{{${body}}}`
    )
  );
}

/** Template-literal text with only the text between references escaped. */
export function escapeTextAroundTokens(
  text: string,
  convertToken: (token: string) => string
): string {
  let result = "";
  let last = 0;
  for (const token of findTemplateTokens(text)) {
    result +=
      escapeTemplateText(text.slice(last, token.start)) +
      convertToken(text.slice(token.start, token.end));
    last = token.end;
  }
  return result + escapeTemplateText(text.slice(last));
}

// Tokens the condition grammar reads one way and JavaScript another: ++ and
// -- (two signs, or an increment), 010 (10, or a module syntax error) and
// 1.e3 (a member of 1, or 1000). Other differences go with the export
// rework; none of them runs code.
const JS_ONLY_TOKENS = /\+\+|--|(?<![\w$.])(?:0\d|\d+\.[A-Za-z_$])/;

/** False when JavaScript would read one of JS_ONLY_TOKENS differently. */
export function readsTheSameInJs(code: string): boolean {
  try {
    return !JS_ONLY_TOKENS.test(maskStringLiterals(code));
  } catch {
    return false;
  }
}

/** Exported code for a condition that uses matchesRegex: it fails loudly. */
export const REGEX_NOT_EXPORTED =
  '(() => { throw new Error("This condition uses matchesRegex, which exported code does not support. Rewrite it by hand."); })()';

/**
 * Escape a string for safe use in template literals
 * Only escapes backslashes and backticks
 */
export function escapeForTemplateLiteral(str: string): string {
  if (!str) {
    return "";
  }
  return str
    .replace(/\\/g, "\\\\") // Escape backslashes first
    .replace(/`/g, "\\`"); // Escape backticks
}

/**
 * Sanitize a function name
 */
export function sanitizeFunctionName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(NUMBER_START_PATTERN, "_$&")
    .replace(/_+/g, "_");
}

/**
 * Sanitize a step name (creates camelCase + Step suffix)
 */
export function sanitizeStepName(name: string): string {
  // Create a more readable function name from the label
  // e.g., "Find Issues" -> "findIssuesStep", "Generate Email Text" -> "generateEmailTextStep"
  const result = name
    .split(WHITESPACE_PATTERN) // Split by whitespace
    .filter((word) => word.length > 0) // Remove empty strings
    .map((word, index) => {
      // Remove non-alphanumeric characters
      const cleaned = word.replace(/[^a-zA-Z0-9]/g, "");
      if (!cleaned) {
        return "";
      }

      // Capitalize first letter of each word except the first
      if (index === 0) {
        return cleaned.toLowerCase();
      }
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
    })
    .filter((word) => word.length > 0) // Remove empty results
    .join("");

  // Ensure we have a valid identifier
  if (!result || result.length === 0) {
    return "unnamedStep";
  }

  // Prefix with underscore if starts with number
  const sanitized = result.replace(NUMBER_START_PATTERN, "_$&");

  // Add "Step" suffix to avoid conflicts with imports (e.g., generateText from 'ai')
  return `${sanitized}Step`;
}

/**
 * Sanitize a variable name
 */
export function sanitizeVarName(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Helper to convert a JavaScript value to TypeScript object literal syntax
 */
export function toTypeScriptLiteral(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => toTypeScriptLiteral(item));
    return `[${items.join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).map(([key, val]) => {
      // Use quoted key only if it's not a valid identifier
      const keyStr = VALID_IDENTIFIER_PATTERN.test(key)
        ? key
        : JSON.stringify(key);
      return `${keyStr}: ${toTypeScriptLiteral(val)}`;
    });
    return `{${entries.join(", ")}}`;
  }
  return String(value);
}

/**
 * Helper to process AI schema and convert to TypeScript literal
 */
export function processAiSchema(aiSchema: string | undefined): string | null {
  if (!aiSchema) {
    return null;
  }

  try {
    const parsedSchema = JSON.parse(aiSchema);
    // Remove id field from each schema object
    const schemaWithoutIds = Array.isArray(parsedSchema)
      ? parsedSchema.map((field: Record<string, unknown>) => {
          const { id: _id, ...rest } = field;
          return rest;
        })
      : parsedSchema;
    return toTypeScriptLiteral(schemaWithoutIds);
  } catch {
    // If schema is invalid JSON, skip it
    return null;
  }
}

// System actions that don't have plugins (step info for generated code)
const SYSTEM_STEP_INFO: Record<
  string,
  { functionName: string; importPath: string }
> = {
  "Database Query": {
    functionName: "databaseQueryStep",
    importPath: "./steps/database-query-step",
  },
  "HTTP Request": {
    functionName: "httpRequestStep",
    importPath: "./steps/http-request-step",
  },
  Condition: {
    functionName: "conditionStep",
    importPath: "./steps/condition-step",
  },
};

/**
 * Helper to convert action type to step function name and import path
 * Uses plugin registry for plugin actions, hardcoded map for system actions
 */
export function getStepInfo(actionType: string): {
  functionName: string;
  importPath: string;
} {
  // Check system actions first
  const systemInfo = SYSTEM_STEP_INFO[actionType];
  if (systemInfo) {
    return systemInfo;
  }

  // Look up in plugin registry
  const action = findActionById(actionType);
  if (action) {
    return {
      functionName: action.stepFunction,
      // Convert plugin's stepImportPath to generated code import path
      // Plugin uses "send-email", generated code uses "./steps/send-email-step"
      importPath: `./steps/${action.stepImportPath}-step`,
    };
  }

  // Fallback for unknown actions
  return {
    functionName: "unknownStep",
    importPath: "./steps/unknown-step",
  };
}
