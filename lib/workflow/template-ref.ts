/**
 * Scanning for `{{...}}` template tokens and splitting for the
 * `{{@nodeId:Label.field}}` references inside them.
 */

export type TemplateToken = {
  /** Index of the opening `{{`. */
  start: number;
  /** Index just past the closing `}}`. */
  end: number;
  /** Text between the braces: never empty, may contain `{` but never `}`. */
  body: string;
};

export type StoredTemplateRef = {
  nodeId: string;
  rest: string;
};

export type TemplateRefParts = {
  label: string;
  fieldPath: string;
};

/**
 * Find the first token at or after `from`, matching what
 * `/\{\{([^}]+)\}\}/g` matches.
 *
 * That regex retries at every `{` and rescans to the next `}` each time, which
 * is quadratic on a long run of `{`. Every `{{` before the same `}` fails or
 * succeeds together, so a failed attempt skips straight past that `}` and the
 * scan stays linear.
 */
export function nextTemplateToken(
  text: string,
  from = 0
): TemplateToken | null {
  let cursor = from;
  while (cursor < text.length) {
    const open = text.indexOf("{{", cursor);
    if (open === -1) {
      return null;
    }
    const close = text.indexOf("}", open + 2);
    if (close === -1) {
      return null;
    }
    if (close > open + 2 && text[close + 1] === "}") {
      return { start: open, end: close + 2, body: text.slice(open + 2, close) };
    }
    cursor = close + 1;
  }
  return null;
}

export function findTemplateTokens(text: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let token = nextTemplateToken(text);
  while (token) {
    tokens.push(token);
    token = nextTemplateToken(text, token.end);
  }
  return tokens;
}

export function hasTemplateToken(text: string): boolean {
  return nextTemplateToken(text) !== null;
}

/**
 * Replace each token with the callback's result, like `String.replace` with
 * `/\{\{([^}]+)\}\}/g`.
 */
export function replaceTemplateTokens(
  text: string,
  replace: (token: TemplateToken) => string
): string {
  let result = "";
  let last = 0;
  for (const token of findTemplateTokens(text)) {
    result += text.slice(last, token.start) + replace(token);
    last = token.end;
  }
  return result + text.slice(last);
}

/**
 * Read a token body of the form `@nodeId:Label.field`, or null for any other
 * body. The node id runs to the first `:` and the rest must be non-empty.
 */
export function parseStoredRef(body: string): StoredTemplateRef | null {
  if (!body.startsWith("@")) {
    return null;
  }
  const colon = body.indexOf(":", 1);
  if (colon <= 1 || colon === body.length - 1) {
    return null;
  }
  return { nodeId: body.slice(1, colon), rest: body.slice(colon + 1) };
}

/** Every `{{@nodeId:Label.field}}` reference in the text, in order. */
export function findStoredRefTokens(
  text: string
): Array<TemplateToken & StoredTemplateRef> {
  const refs: Array<TemplateToken & StoredTemplateRef> = [];
  for (const token of findTemplateTokens(text)) {
    const ref = parseStoredRef(token.body);
    if (ref) {
      refs.push({ ...token, ...ref });
    }
  }
  return refs;
}

/** The first `{{@nodeId:Label.field}}` reference in the text, if any. */
export function findStoredRef(text: string): StoredTemplateRef | null {
  return findStoredRefTokens(text)[0] ?? null;
}

/**
 * Read a value that is exactly one token, with nothing before or after it.
 */
export function parseWholeTemplateToken(value: string): TemplateToken | null {
  const token = nextTemplateToken(value);
  return token?.start === 0 && token.end === value.length ? token : null;
}

/**
 * Split `Label.field` into its label and field path.
 *
 * The label is baked into the token at authoring time and may itself contain
 * dots (a node named "check app.keeperhub.com"), so splitting on the first dot
 * reads part of the label as the field path. Prefer the node's known label and
 * fall back to the first dot when it is absent or stale, which is what a
 * reference stored before the node was renamed carries.
 */
export function splitTemplateRef(
  rest: string,
  nodeLabel?: string
): TemplateRefParts {
  if (nodeLabel) {
    if (rest === nodeLabel) {
      return { label: nodeLabel, fieldPath: "" };
    }
    if (rest.startsWith(`${nodeLabel}.`)) {
      return { label: nodeLabel, fieldPath: rest.slice(nodeLabel.length + 1) };
    }
  }

  const dotIndex = rest.indexOf(".");
  if (dotIndex === -1) {
    return { label: rest, fieldPath: "" };
  }
  return {
    label: rest.slice(0, dotIndex),
    fieldPath: rest.slice(dotIndex + 1),
  };
}
