/**
 * Safe condition expression evaluator (A-01 hardening).
 *
 * Replaces the previous `new Function(...)` evaluation of user-authored
 * Condition expressions with a self-contained tokenizer, Pratt parser, and a
 * strictly allowlisted tree-walking interpreter. The interpreter never
 * constructs functions and never reaches host globals, so a condition string
 * can only read the already-resolved `__vN`/`__bN` values and apply a fixed
 * set of operators and methods.
 *
 * Supported grammar (identical to what the validator/visual-builder emit):
 * - Literals: numbers, strings, true, false, null, undefined
 * - Comparison: === !== == != > < >= <=
 * - Arithmetic: + - * / % **
 * - Logical: && || ! (with short-circuit)
 * - Unary: ! - + typeof
 * - Ternary: test ? a : b
 * - Member access: obj.prop, obj["key"], obj[0], .length
 * - Calls: String(...), Array.isArray(...), Object.keys(...), and the
 *   allowlisted instance methods (includes/startsWith/endsWith/toString/
 *   toLowerCase/toUpperCase/trim)
 *
 * Everything else (arbitrary identifiers, array/object literals, prototype
 * access, and any other call target) throws.
 */

import {
  isEqualityOperator,
  isMissingReference,
  isPresenceProbe,
  type MissingReference,
  missingReferenceError,
} from "./missing-reference";

const HEX_RE = /^[0-9a-fA-F]+$/;
const WHITESPACE_RE = /\s/;

const ALLOWED_METHODS = new Set([
  "includes",
  "startsWith",
  "endsWith",
  "toString",
  "toLowerCase",
  "toUpperCase",
  "trim",
]);

const ALLOWED_UNARY = new Set(["!", "-", "+", "typeof"]);

const BLOCKED_PROPS = new Set(["constructor", "__proto__", "prototype"]);

const ALLOWED_GLOBALS: Record<string, (...args: unknown[]) => unknown> = {
  String: (...args) => String(args[0]),
};

const ALLOWED_STATIC: Record<string, (...args: unknown[]) => unknown> = {
  "Array.isArray": (...args) => Array.isArray(args[0]),
  "Object.keys": (...args) => Object.keys(args[0] as object),
};

// Left binding powers for the precedence-climbing parser. Higher binds tighter.
const BINARY_BP: Record<string, number> = {
  "||": 3,
  "&&": 4,
  "==": 9,
  "!=": 9,
  "===": 9,
  "!==": 9,
  "<": 10,
  "<=": 10,
  ">": 10,
  ">=": 10,
  "+": 12,
  "-": 12,
  "*": 13,
  "/": 13,
  "%": 13,
  "**": 14,
};

const RIGHT_ASSOCIATIVE = new Set(["**"]);
const LOGICAL_OPERATORS = new Set(["&&", "||"]);

const MULTI_CHAR_PUNCTUATORS = [
  "===",
  "!==",
  "**",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
];

const SINGLE_CHAR_PUNCTUATORS = new Set([
  "!",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "(",
  ")",
  "[",
  "]",
  ".",
  "?",
  ":",
  ",",
]);

type LiteralNode = { type: "Literal"; value: unknown };
type IdentifierNode = { type: "Identifier"; name: string };
type UnaryNode = {
  type: "UnaryExpression";
  operator: string;
  argument: AstNode;
};
type BinaryNode = {
  type: "BinaryExpression";
  operator: string;
  left: AstNode;
  right: AstNode;
};
type LogicalNode = {
  type: "LogicalExpression";
  operator: string;
  left: AstNode;
  right: AstNode;
};
type ConditionalNode = {
  type: "ConditionalExpression";
  test: AstNode;
  consequent: AstNode;
  alternate: AstNode;
};
type MemberNode = {
  type: "MemberExpression";
  object: AstNode;
  property: AstNode;
  computed: boolean;
};
type CallNode = {
  type: "CallExpression";
  callee: AstNode;
  arguments: AstNode[];
};

type AstNode =
  | LiteralNode
  | IdentifierNode
  | UnaryNode
  | BinaryNode
  | LogicalNode
  | ConditionalNode
  | MemberNode
  | CallNode;

type Token = { type: "num" | "str" | "ident" | "punct"; value: string };

function isIdentifierStart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "_" ||
    ch === "$"
  );
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || (ch >= "0" && ch <= "9");
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function decodeHexEscape(
  src: string,
  backslashIndex: number,
  count: number
): { value: string; next: number } {
  const hex = src.slice(backslashIndex + 2, backslashIndex + 2 + count);
  if (hex.length < count || !HEX_RE.test(hex)) {
    throw new Error("Invalid escape sequence in string literal");
  }
  return {
    value: String.fromCodePoint(Number.parseInt(hex, 16)),
    next: backslashIndex + 2 + count,
  };
}

function decodeUnicodeEscape(
  src: string,
  backslashIndex: number
): { value: string; next: number } {
  const afterU = backslashIndex + 2;
  if (src[afterU] === "{") {
    const end = src.indexOf("}", afterU);
    if (end === -1) {
      throw new Error("Invalid escape sequence in string literal");
    }
    const hex = src.slice(afterU + 1, end);
    if (hex.length === 0 || !HEX_RE.test(hex)) {
      throw new Error("Invalid escape sequence in string literal");
    }
    return {
      value: String.fromCodePoint(Number.parseInt(hex, 16)),
      next: end + 1,
    };
  }
  return decodeHexEscape(src, backslashIndex, 4);
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

function decodeEscape(
  src: string,
  backslashIndex: number
): { value: string; next: number } {
  const esc = src[backslashIndex + 1];
  if (esc === undefined) {
    throw new Error("Unterminated string literal");
  }
  if (esc === "x") {
    return decodeHexEscape(src, backslashIndex, 2);
  }
  if (esc === "u") {
    return decodeUnicodeEscape(src, backslashIndex);
  }
  const simple = SIMPLE_ESCAPES[esc];
  if (simple !== undefined) {
    return { value: simple, next: backslashIndex + 2 };
  }
  return { value: esc, next: backslashIndex + 2 };
}

function scanString(
  src: string,
  start: number
): { value: string; next: number } {
  const quote = src[start];
  let i = start + 1;
  let out = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      const decoded = decodeEscape(src, i);
      out += decoded.value;
      i = decoded.next;
      continue;
    }
    if (ch === quote) {
      return { value: out, next: i + 1 };
    }
    out += ch;
    i += 1;
  }
  throw new Error("Unterminated string literal");
}

function scanNumber(
  src: string,
  start: number
): { value: string; next: number } {
  let i = start;
  while (i < src.length && isDigit(src[i])) {
    i += 1;
  }
  if (src[i] === "." && isDigit(src[i + 1] ?? "")) {
    i += 1;
    while (i < src.length && isDigit(src[i])) {
      i += 1;
    }
  }
  return { value: src.slice(start, i), next: i };
}

function scanPunctuator(
  src: string,
  start: number
): { value: string; next: number } {
  for (const punct of MULTI_CHAR_PUNCTUATORS) {
    if (src.startsWith(punct, start)) {
      return { value: punct, next: start + punct.length };
    }
  }
  const ch = src[start];
  if (SINGLE_CHAR_PUNCTUATORS.has(ch)) {
    return { value: ch, next: start + 1 };
  }
  throw new Error(`Invalid character "${ch}" in condition`);
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (WHITESPACE_RE.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const scanned = scanString(src, i);
      tokens.push({ type: "str", value: scanned.value });
      i = scanned.next;
      continue;
    }
    if (isDigit(ch)) {
      const scanned = scanNumber(src, i);
      tokens.push({ type: "num", value: scanned.value });
      i = scanned.next;
      continue;
    }
    if (isIdentifierStart(ch)) {
      let j = i + 1;
      while (j < src.length && isIdentifierPart(src[j])) {
        j += 1;
      }
      tokens.push({ type: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }
    const scanned = scanPunctuator(src, i);
    tokens.push({ type: "punct", value: scanned.value });
    i = scanned.next;
  }
  return tokens;
}

function literalFromIdentifier(name: string): AstNode {
  switch (name) {
    case "true":
      return { type: "Literal", value: true };
    case "false":
      return { type: "Literal", value: false };
    case "null":
      return { type: "Literal", value: null };
    case "undefined":
      return { type: "Literal", value: undefined };
    default:
      return { type: "Identifier", name };
  }
}

function parse(expression: string): AstNode {
  const tokens = tokenize(expression);
  let pos = 0;

  function peek(): Token | undefined {
    return tokens[pos];
  }

  function next(): Token | undefined {
    const token = tokens[pos];
    pos += 1;
    return token;
  }

  function expectPunct(value: string): void {
    const token = next();
    if (token?.type !== "punct" || token.value !== value) {
      throw new Error(`Expected "${value}" in condition`);
    }
  }

  function parseArguments(): AstNode[] {
    const args: AstNode[] = [];
    if (peek()?.value === ")") {
      next();
      return args;
    }
    while (true) {
      args.push(parseConditional());
      const token = next();
      if (token?.value === ")") {
        return args;
      }
      if (token?.value !== ",") {
        throw new Error("Malformed argument list in condition");
      }
    }
  }

  function parsePrimary(): AstNode {
    const token = next();
    if (!token) {
      throw new Error("Unexpected end of condition expression");
    }
    if (token.type === "num") {
      return { type: "Literal", value: Number(token.value) };
    }
    if (token.type === "str") {
      return { type: "Literal", value: token.value };
    }
    if (token.type === "ident") {
      return literalFromIdentifier(token.value);
    }
    if (token.value === "(") {
      const expr = parseConditional();
      expectPunct(")");
      return expr;
    }
    throw new Error(`Unexpected token "${token.value}" in condition`);
  }

  function parseCallMember(): AstNode {
    let node = parsePrimary();
    while (true) {
      const token = peek();
      if (token?.type !== "punct") {
        return node;
      }
      if (token.value === ".") {
        next();
        const prop = next();
        if (prop?.type !== "ident") {
          throw new Error("Expected property name after '.' in condition");
        }
        node = {
          type: "MemberExpression",
          object: node,
          property: { type: "Identifier", name: prop.value },
          computed: false,
        };
      } else if (token.value === "[") {
        next();
        const property = parseConditional();
        expectPunct("]");
        node = {
          type: "MemberExpression",
          object: node,
          property,
          computed: true,
        };
      } else if (token.value === "(") {
        next();
        node = {
          type: "CallExpression",
          callee: node,
          arguments: parseArguments(),
        };
      } else {
        return node;
      }
    }
  }

  function parseUnary(): AstNode {
    const token = peek();
    const isUnaryPunct =
      token?.type === "punct" &&
      (token.value === "!" || token.value === "-" || token.value === "+");
    const isTypeof = token?.type === "ident" && token.value === "typeof";
    if (token && (isUnaryPunct || isTypeof)) {
      next();
      return {
        type: "UnaryExpression",
        operator: token.value,
        argument: parseUnary(),
      };
    }
    return parseCallMember();
  }

  function parseBinary(minBp: number): AstNode {
    let left = parseUnary();
    while (true) {
      const token = peek();
      if (token?.type !== "punct") {
        return left;
      }
      const bp = BINARY_BP[token.value];
      if (bp === undefined || bp < minBp) {
        return left;
      }
      next();
      const nextMin = RIGHT_ASSOCIATIVE.has(token.value) ? bp : bp + 1;
      const right = parseBinary(nextMin);
      left = LOGICAL_OPERATORS.has(token.value)
        ? { type: "LogicalExpression", operator: token.value, left, right }
        : { type: "BinaryExpression", operator: token.value, left, right };
    }
  }

  function parseConditional(): AstNode {
    const test = parseBinary(0);
    if (peek()?.value === "?") {
      next();
      const consequent = parseConditional();
      expectPunct(":");
      const alternate = parseConditional();
      return { type: "ConditionalExpression", test, consequent, alternate };
    }
    return test;
  }

  const ast = parseConditional();
  if (pos < tokens.length) {
    throw new Error(`Unexpected token "${tokens[pos].value}" in condition`);
  }
  return ast;
}

/**
 * A reference whose field path was not present resolves to a marker rather
 * than a bare undefined, so the operator decides what it means. Presence
 * checks read it as undefined; everything else rejects it, which stops a
 * mistyped path from quietly satisfying a comparison.
 */
function resolveMissingOperands(
  operator: string,
  left: unknown,
  right: unknown
): { left: unknown; right: unknown } {
  const leftMissing = isMissingReference(left);
  const rightMissing = isMissingReference(right);
  if (!(leftMissing || rightMissing)) {
    return { left, right };
  }

  const probesPresence =
    isEqualityOperator(operator) &&
    ((leftMissing && isPresenceProbe(right)) ||
      (rightMissing && isPresenceProbe(left)));

  if (!probesPresence) {
    throw missingReferenceError(
      (leftMissing ? left : right) as MissingReference
    );
  }

  return {
    left: leftMissing ? undefined : left,
    right: rightMissing ? undefined : right,
  };
}

function applyBinary(
  operator: string,
  rawLeft: unknown,
  rawRight: unknown
): unknown {
  const { left, right } = resolveMissingOperands(operator, rawLeft, rawRight);

  switch (operator) {
    case "===":
      return left === right;
    case "!==":
      return left !== right;
    case "==":
      // biome-ignore lint/suspicious/noDoubleEquals: condition grammar intentionally supports loose == for cross-type comparisons
      return left == right;
    case "!=":
      // biome-ignore lint/suspicious/noDoubleEquals: condition grammar intentionally supports loose != for cross-type comparisons
      return left != right;
    case ">":
      return (left as number) > (right as number);
    case "<":
      return (left as number) < (right as number);
    case ">=":
      return (left as number) >= (right as number);
    case "<=":
      return (left as number) <= (right as number);
    case "+":
      return (left as number) + (right as number);
    case "-":
      return (left as number) - (right as number);
    case "*":
      return (left as number) * (right as number);
    case "/":
      return (left as number) / (right as number);
    case "%":
      return (left as number) % (right as number);
    case "**":
      return (left as number) ** (right as number);
    default:
      throw new Error(`Operator not allowed in condition: ${operator}`);
  }
}

function applyUnary(operator: string, argument: unknown): unknown {
  if (isMissingReference(argument)) {
    throw missingReferenceError(argument);
  }
  switch (operator) {
    case "!":
      return !argument;
    case "-":
      return -(argument as number);
    case "+":
      return +(argument as number);
    case "typeof":
      return typeof argument;
    default:
      throw new Error(`Unary operator not allowed in condition: ${operator}`);
  }
}

function callMethod(
  receiver: unknown,
  method: string,
  args: unknown[]
): unknown {
  if (typeof receiver === "string") {
    const fn = (String.prototype as unknown as Record<string, unknown>)[
      method
    ] as (...a: unknown[]) => unknown;
    return fn.apply(receiver, args);
  }
  if (Array.isArray(receiver)) {
    const fn = (Array.prototype as unknown as Record<string, unknown>)[
      method
    ] as (...a: unknown[]) => unknown;
    return fn.apply(receiver, args);
  }
  const target =
    receiver === null || receiver === undefined
      ? undefined
      : (receiver as Record<string, unknown>)[method];
  if (typeof target !== "function") {
    throw new Error(`Method "${method}" is not callable in condition`);
  }
  return (target as (...a: unknown[]) => unknown).apply(receiver, args);
}

function evalIdentifier(name: string, ctx: Record<string, unknown>): unknown {
  if (Object.hasOwn(ctx, name)) {
    return ctx[name];
  }
  throw new Error(`Unknown identifier "${name}" in condition`);
}

function memberKey(
  node: MemberNode,
  ctx: Record<string, unknown>
): string | number {
  if (node.computed) {
    const key = evalNode(node.property, ctx);
    if (typeof key !== "string" && typeof key !== "number") {
      throw new Error("Computed member key must be a string or number");
    }
    if (typeof key === "string" && BLOCKED_PROPS.has(key)) {
      throw new Error(`Property access not allowed in condition: ${key}`);
    }
    return key;
  }
  if (node.property.type !== "Identifier") {
    throw new Error("Invalid member expression in condition");
  }
  const name = node.property.name;
  if (BLOCKED_PROPS.has(name)) {
    throw new Error(`Property access not allowed in condition: ${name}`);
  }
  return name;
}

function evalMember(node: MemberNode, ctx: Record<string, unknown>): unknown {
  const key = memberKey(node, ctx);
  const object = evalNode(node.object, ctx);
  if (object === null || object === undefined) {
    throw new Error(
      `Cannot read property "${String(key)}" of ${String(object)}`
    );
  }
  return (object as Record<string | number, unknown>)[key];
}

function evalCall(node: CallNode, ctx: Record<string, unknown>): unknown {
  const callee = node.callee;
  if (callee.type === "Identifier") {
    const fn = ALLOWED_GLOBALS[callee.name];
    if (!fn) {
      throw new Error(`Function "${callee.name}" is not allowed in condition`);
    }
    return fn(...node.arguments.map((arg) => evalNode(arg, ctx)));
  }
  if (callee.type === "MemberExpression" && !callee.computed) {
    if (callee.property.type !== "Identifier") {
      throw new Error("Invalid call expression in condition");
    }
    const method = callee.property.name;
    if (
      callee.object.type === "Identifier" &&
      !Object.hasOwn(ctx, callee.object.name)
    ) {
      const staticFn = ALLOWED_STATIC[`${callee.object.name}.${method}`];
      if (!staticFn) {
        throw new Error(
          `Function "${callee.object.name}.${method}" is not allowed in condition`
        );
      }
      return staticFn(...node.arguments.map((arg) => evalNode(arg, ctx)));
    }
    if (BLOCKED_PROPS.has(method) || !ALLOWED_METHODS.has(method)) {
      throw new Error(`Method "${method}" is not allowed in condition`);
    }
    const receiver = evalNode(callee.object, ctx);
    return callMethod(
      receiver,
      method,
      node.arguments.map((arg) => evalNode(arg, ctx))
    );
  }
  throw new Error("Unsupported call expression in condition");
}

function evalNode(node: AstNode, ctx: Record<string, unknown>): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "Identifier":
      return evalIdentifier(node.name, ctx);
    case "UnaryExpression":
      return applyUnary(node.operator, evalNode(node.argument, ctx));
    case "BinaryExpression":
      return applyBinary(
        node.operator,
        evalNode(node.left, ctx),
        evalNode(node.right, ctx)
      );
    case "LogicalExpression": {
      const left = evalNode(node.left, ctx);
      if (node.operator === "&&") {
        return left ? evalNode(node.right, ctx) : left;
      }
      return left ? left : evalNode(node.right, ctx);
    }
    case "ConditionalExpression":
      return evalNode(node.test, ctx)
        ? evalNode(node.consequent, ctx)
        : evalNode(node.alternate, ctx);
    case "MemberExpression":
      return evalMember(node, ctx);
    default:
      return evalCall(node, ctx);
  }
}

function walkAllowlist(node: AstNode): void {
  switch (node.type) {
    case "Literal":
    case "Identifier":
      return;
    case "UnaryExpression":
      if (!ALLOWED_UNARY.has(node.operator)) {
        throw new Error(`Unary operator not allowed: ${node.operator}`);
      }
      walkAllowlist(node.argument);
      return;
    case "BinaryExpression":
      if (BINARY_BP[node.operator] === undefined) {
        throw new Error(`Operator not allowed: ${node.operator}`);
      }
      walkAllowlist(node.left);
      walkAllowlist(node.right);
      return;
    case "LogicalExpression":
      if (!LOGICAL_OPERATORS.has(node.operator)) {
        throw new Error(`Operator not allowed: ${node.operator}`);
      }
      walkAllowlist(node.left);
      walkAllowlist(node.right);
      return;
    case "ConditionalExpression":
      walkAllowlist(node.test);
      walkAllowlist(node.consequent);
      walkAllowlist(node.alternate);
      return;
    case "MemberExpression":
      walkMember(node);
      return;
    default:
      walkCall(node);
  }
}

function walkMember(node: MemberNode): void {
  if (
    !node.computed &&
    node.property.type === "Identifier" &&
    BLOCKED_PROPS.has(node.property.name)
  ) {
    throw new Error(`Property access not allowed: ${node.property.name}`);
  }
  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string" &&
    BLOCKED_PROPS.has(node.property.value)
  ) {
    throw new Error(`Property access not allowed: ${node.property.value}`);
  }
  walkAllowlist(node.object);
  if (node.computed) {
    walkAllowlist(node.property);
  }
}

function walkCall(node: CallNode): void {
  const callee = node.callee;
  if (callee.type === "Identifier") {
    if (!Object.hasOwn(ALLOWED_GLOBALS, callee.name)) {
      throw new Error(`Function "${callee.name}" is not allowed`);
    }
  } else if (callee.type === "MemberExpression" && !callee.computed) {
    if (callee.property.type !== "Identifier") {
      throw new Error("Invalid call expression");
    }
    const method = callee.property.name;
    const isStatic =
      callee.object.type === "Identifier" &&
      Object.hasOwn(ALLOWED_STATIC, `${callee.object.name}.${method}`);
    if (!isStatic) {
      if (BLOCKED_PROPS.has(method) || !ALLOWED_METHODS.has(method)) {
        throw new Error(`Method "${method}" is not allowed`);
      }
      walkAllowlist(callee.object);
    }
  } else {
    throw new Error("Unsupported call expression");
  }
  for (const arg of node.arguments) {
    walkAllowlist(arg);
  }
}

/**
 * Parse and evaluate a transformed condition expression against the resolved
 * `__vN`/`__bN` context. Throws on any disallowed syntax or unknown identifier.
 */
export function safeEvaluateCondition(
  expression: string,
  context: Record<string, unknown>
): unknown {
  let ast: AstNode;
  try {
    ast = parse(expression);
  } catch (error) {
    throw new Error(
      `Condition parse error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return evalNode(ast, context);
}

/**
 * Static (non-evaluating) check that an expression only uses the allowlisted
 * grammar. Used by the code generator to neutralize injected/invalid
 * expressions in displayed/exported source.
 */
export function isSafeConditionExpression(expression: string): boolean {
  try {
    walkAllowlist(parse(expression));
    return true;
  } catch {
    return false;
  }
}
