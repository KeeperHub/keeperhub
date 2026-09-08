#!/usr/bin/env tsx

/**
 * Static guard against docs-vs-code drift in the public API.
 *
 * For every (METHOD, /api/path) a page under docs/api/**.md advertises,
 * this script asserts that the corresponding Next.js App Router route file
 * (app/api/<segments>/route.ts) exists and exports a handler for that
 * method. Path parameters in docs (`{id}`) are mapped to the filesystem
 * convention (`[id]`).
 *
 * Three declaration formats are read, because pages use all three:
 *
 *   1. `http-fence`  - a fenced ```http block. The canonical form.
 *   2. `inline-code` - a `POST /api/keys` code span in prose or in a
 *                      markdown table cell. The method has to sit inside
 *                      the same span as the path, which is what keeps a
 *                      docs-site link like [User API](/api/user) - no
 *                      method, no span - from being read as a route.
 *   3. `code-sample` - a path literal passed as the first argument of a
 *                      recognised request call inside a ```ts / ```js
 *                      block: api("/api/user"), post("/api/keys", ...),
 *                      api(`/api/x/${id}/y`). The method comes from an
 *                      explicit `method: "POST"`, else from the helper
 *                      name, else GET. A call that is neither - new
 *                      URL("/api/x", base), console.log("/api/keys") - is
 *                      a string, not a declaration. A URL assembled from
 *                      variables (fetch(BASE + path)) is out of reach and
 *                      is deliberately not guessed at.
 *
 * Nothing inside an HTML comment is scanned, prose and fenced blocks
 * alike, and a line ending in `<!-- api-docs-ignore -->` is skipped in
 * all three formats, so a page can say that `POST /api/legacy/thing` was
 * removed without failing the build. In prose the marker renders as
 * nothing; inside a fence it renders as literal text, which is the price
 * of the fence being the natural place to write a removed endpoint.
 *
 * When the same endpoint is declared twice, the artifact records the
 * highest-priority format in the order above, so adding formats 2 and 3
 * never rewrites an entry an ```http fence already owns.
 *
 * Exits non-zero on any drift. Also emits specs/api-coverage.json so the
 * post-deploy live HEAD check (deploy-keeperhub.yaml) reads the same
 * source of truth without re-parsing markdown in YAML. Note that the
 * exit code is not the only signal: CI diffs the regenerated artifact
 * separately, so a clean exit with an uncommitted artifact still fails.
 *
 * Routes that exist in code but appear in no docs file are surfaced as
 * warnings, not failures - many internal/cron/og/auth routes are
 * intentionally undocumented.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");
const DOCS_DIR = join(REPO_ROOT, "docs/api");
const APP_API_DIR = join(REPO_ROOT, "app/api");
const COVERAGE_OUT = join(REPO_ROOT, "specs/api-coverage.json");

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const HTTP_METHODS: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

export type EndpointFormat = "http-fence" | "inline-code" | "code-sample";

// Lower wins when the same endpoint is declared in more than one format.
const FORMAT_PRIORITY: Record<EndpointFormat, number> = {
  "http-fence": 0,
  "inline-code": 1,
  "code-sample": 2,
};

export type DocumentedEndpoint = {
  method: HttpMethod;
  path: string; // canonical, with {param} placeholders
  source: string; // docs file (repo-relative)
  line: number; // 1-based line in source
  format: EndpointFormat;
};

type Drift =
  | {
      kind: "missing-file";
      endpoint: DocumentedEndpoint;
      expectedShape: string;
    }
  | {
      kind: "missing-method";
      endpoint: DocumentedEndpoint;
      routeFile: string;
    };

// Routes that intentionally have no public-facing docs page. We do NOT
// fail or warn on these when walking app/api/** in reverse.
const UNDOCUMENTED_PREFIX_ALLOWLIST: readonly string[] = [
  "/api/internal/",
  "/api/cron/",
  "/api/admin/",
  "/api/og/",
  "/api/metrics",
  "/api/auth/",
  "/api/oauth/",
  "/api/health",
  "/api/openapi",
  "/api/feedback", // platform internal feedback collector
  "/api/features",
  "/api/notifications/",
  "/api/billing/webhooks/", // 3rd-party callback surface
  "/api/agent-registry",
  "/api/protocols", // exposed via hub, not public REST docs
  "/api/supported-tokens",
  "/api/validate-token",
  "/api/web3/", // legacy alias under chains
  "/api/gas/",
  "/api/mcp/", // documented via MCP catalog, not REST docs
];

// Catch-all route files that genuinely own their whole subtree, so a
// documented path under them is served even though no file bears its name.
// Better Auth mounts every /api/auth/* endpoint - siwe/nonce, siwe/verify,
// sign-up/email - inside one handler, which is why documenting them is not
// drift.
//
// This is an allowlist rather than a denylist on purpose. The other two
// catch-alls must not resolve anything:
//   - app/api/[...slug]/route.ts answers 404 for unmatched paths and
//     exports every method, so it would make this guard pass for any path.
//   - app/api/execute/[...slug]/route.ts dispatches protocol actions at
//     runtime, so it would swallow a typo like /api/execute/tarnsfer that
//     the exact-match check catches today.
const DELEGATED_CATCH_ALL_ROUTES: readonly string[] = [
  "app/api/auth/[...all]/route.ts",
];

const CODE_SAMPLE_LANGS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "typescript",
  "js",
  "jsx",
  "javascript",
]);

// `POST /api/keys` inside a single code span - the form tables and prose use.
const INLINE_CODE_ENDPOINT_RE =
  /`\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^`\s]+)\s*`/g;

// helper("/api/...") or helper(`/api/...`) - the path as the first argument.
const CALL_PATH_LITERAL_RE = /([\w$]+)\s*\(\s*(["'`])(\/api\/[^"'`\n]*)\2/g;

const METHOD_OPTION_RE = /\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i;

// Request helpers whose name carries the verb: post(...), del(...).
const HELPER_METHODS: ReadonlyMap<string, HttpMethod> = new Map([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["patch", "PATCH"],
  ["del", "DELETE"],
  ["delete", "DELETE"],
]);

// Request helpers that do not name a method: the verb comes from a
// `method:` option, else GET. A call that is in neither map is not read as
// a declaration at all, which is what keeps `new URL("/api/x", base)` and
// `console.log("/api/keys")` from claiming a route.
const NEUTRAL_REQUEST_HELPERS: ReadonlySet<string> = new Set([
  "api",
  "fetch",
  "request",
]);

// Characters a canonical route path may contain once placeholders are
// normalised. Anything else means we did not understand the literal, and a
// guess would be worse than a miss.
const PLAUSIBLE_ROUTE_PATH_RE = /^\/api\/[A-Za-z0-9\-_./{}]*$/u;

// A template hole we can name a parameter after: an identifier or a
// property chain. `${a + b}` is neither, and naming it after its last
// identifier produces a placeholder that reads like a real parameter.
const SIMPLE_TEMPLATE_HOLE_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;

// Both fence markers CommonMark allows. The marker is captured so that a
// ``` line inside a ~~~ block counts as content rather than closing it.
const FENCE_RE = /^\s*(```|~~~)(\S*)/;

// Opt-out for a line that names an endpoint without claiming it exists -
// "`POST /api/legacy/thing` was removed in v2". Written as an HTML comment
// so it renders as nothing in prose, and read from the raw line before
// comments are stripped. Anchored to the end of the line because that is
// what the header promises: unanchored, a marker written at the front of
// a line silently drops every real declaration behind it as well.
const IGNORE_MARKER_RE = /<!--\s*api-docs-ignore\s*-->\s*$/;
const IGNORE_MARKER = "<!-- api-docs-ignore -->";

function walkFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkFiles(full, suffix));
    } else if (name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip the query string, trailing sentence punctuation and trailing
 * slashes. We only validate the route, not its query parameters.
 */
function canonicalizePath(rawPath: string): string {
  return rawPath
    .split("?")[0]
    .replace(/[).,;]+$/u, "")
    .replace(/\/+$/u, "");
}

/**
 * Turn a template-literal path into a canonical one:
 *   /api/execute/${exec.executionId}/status
 *     -> /api/execute/{executionId}/status
 * The last identifier of the interpolation names the parameter, so a
 * sample and the prose that documents the same route collapse to one
 * entry instead of two. An expression that is not a plain identifier or
 * property chain has no name to borrow - `${a + b}` becomes `{param}`
 * rather than `{b}`, which would read like a parameter the API has.
 * Returns null when the result is not a shape we can reason about.
 */
export function canonicalizeSamplePath(rawPath: string): string | null {
  const withPlaceholders = rawPath.replace(
    /\$\{([^}]*)\}/gu,
    (_match: string, expression: string) => {
      const trimmed = expression.trim();
      if (!SIMPLE_TEMPLATE_HOLE_RE.test(trimmed)) {
        return "{param}";
      }
      return `{${trimmed.split(".").at(-1)}}`;
    }
  );
  const canonical = canonicalizePath(withPlaceholders);
  return PLAUSIBLE_ROUTE_PATH_RE.test(canonical) ? canonical : null;
}

/**
 * Walk forward from `start` to the `)` that closes the call, skipping
 * string and template contents so a paren inside a literal cannot end the
 * span early. `ceiling` bounds the walk at the next path literal in the
 * block, so an unbalanced paren in a comment can never let one call's
 * `method:` be attributed to another call's path.
 */
function callArgumentSpan(text: string, start: number, ceiling: number): string {
  let depth = 1;
  let index = start;
  let quote: string | null = null;
  while (index < ceiling && depth > 0) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      index++;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      index++;
      continue;
    }
    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
    }
    index++;
  }
  return text.slice(start, index);
}

/**
 * The method a sample call declares, or null when the call is not a
 * request at all.
 *
 * An explicit `method:` option outranks the helper name, because the
 * helper name is only an inference: `get(url, { method: "POST" })` sends a
 * POST. A call that neither names a verb nor is a recognised request
 * helper is not a declaration - `new URL("/api/user/wallet/withdraw",
 * base)` is a string, not a documented GET.
 */
function resolveSampleMethod(helper: string, span: string): HttpMethod | null {
  const explicit = span.match(METHOD_OPTION_RE)?.[1].toUpperCase();
  if (explicit) {
    return explicit as HttpMethod;
  }
  const name = helper.toLowerCase();
  const inferred = HELPER_METHODS.get(name);
  if (inferred) {
    return inferred;
  }
  return NEUTRAL_REQUEST_HELPERS.has(name) ? "GET" : null;
}

/**
 * Extract endpoints from a ```ts / ```js sample. `startLine` is the
 * 1-based line of the block's opening fence.
 */
export function parseCodeSampleBlock(
  block: string,
  startLine: number,
  source: string
): DocumentedEndpoint[] {
  const matches = [...block.matchAll(CALL_PATH_LITERAL_RE)];
  const endpoints: DocumentedEndpoint[] = [];
  for (const [position, match] of matches.entries()) {
    const [whole, helper, , rawPath] = match;
    const matchIndex = match.index ?? 0;
    const path = canonicalizeSamplePath(rawPath);
    if (path === null) {
      continue;
    }
    const ceiling = matches[position + 1]?.index ?? block.length;
    const span = callArgumentSpan(block, matchIndex + whole.length, ceiling);
    const method = resolveSampleMethod(helper, span);
    if (method === null) {
      continue;
    }
    // Lines are counted in the block, then offset by the fence line.
    const linesBefore = block.slice(0, matchIndex).split("\n").length - 1;
    endpoints.push({
      method,
      path,
      source,
      line: startLine + 1 + linesBefore,
      format: "code-sample",
    });
  }
  return endpoints;
}

/**
 * Blank out every HTML-comment region on a line, carrying an unterminated
 * comment across lines. Commented-out prose renders as nothing on the docs
 * site, so it must not create a CI-gating claim either.
 */
function stripHtmlComments(line: string, state: { open: boolean }): string {
  let out = "";
  let index = 0;
  while (index < line.length) {
    if (state.open) {
      const close = line.indexOf("-->", index);
      if (close === -1) {
        return out;
      }
      state.open = false;
      index = close + "-->".length;
      continue;
    }
    const open = line.indexOf("<!--", index);
    if (open === -1) {
      return out + line.slice(index);
    }
    out += line.slice(index, open);
    state.open = true;
    index = open + "<!--".length;
  }
  return out;
}

/**
 * Parse one markdown page in document order across all three formats.
 * Returns matches with 1-based line numbers.
 */
export function parseMarkdownEndpoints(
  text: string,
  source: string
): DocumentedEndpoint[] {
  const lines = text.split(/\r?\n/);
  const endpoints: DocumentedEndpoint[] = [];
  let fenceLang: string | null = null;
  let fenceMarker = "";
  let fenceStart = 0;
  let sampleLines: string[] = [];
  const comment = { open: false };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Comment state advances before the fence match, so a fenced block
    // written inside an HTML comment never opens one - it renders as
    // nothing on the docs site and must not gate CI either. Inside a
    // fence, `<!--` is content: only the closing fence gets us out.
    // Annotated because `fenceLang` is assigned below from a match on this
    // value, and inference would have to walk that cycle.
    const visible: string =
      fenceLang === null ? stripHtmlComments(raw, comment) : raw;
    const fence = visible.match(FENCE_RE);
    // A fence marker only closes the block it opened, so ``` inside a ~~~
    // block (and the reverse) is content.
    if (fence && (fenceLang === null || fence[1] === fenceMarker)) {
      if (fenceLang === null) {
        fenceMarker = fence[1];
        fenceLang = fence[2].toLowerCase();
        fenceStart = i + 1;
        sampleLines = [];
      } else {
        if (CODE_SAMPLE_LANGS.has(fenceLang)) {
          endpoints.push(
            ...parseCodeSampleBlock(sampleLines.join("\n"), fenceStart, source)
          );
        }
        fenceLang = null;
      }
      continue;
    }
    if (fenceLang === "http") {
      if (IGNORE_MARKER_RE.test(raw)) {
        continue;
      }
      const match = raw.match(/^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/\S+)/);
      if (match) {
        endpoints.push({
          method: match[1] as HttpMethod,
          path: canonicalizePath(match[2]),
          source,
          line: i + 1,
          format: "http-fence",
        });
      }
      continue;
    }
    if (fenceLang !== null) {
      if (CODE_SAMPLE_LANGS.has(fenceLang)) {
        // A marked line is blanked rather than dropped, so the line
        // numbers the block reports stay the line numbers the file has.
        sampleLines.push(IGNORE_MARKER_RE.test(raw) ? "" : raw);
      }
      continue;
    }
    // The marker is read off the raw text: it lives inside a comment, and
    // stripping comments would eat it.
    if (IGNORE_MARKER_RE.test(raw)) {
      continue;
    }
    for (const match of visible.matchAll(INLINE_CODE_ENDPOINT_RE)) {
      const path = canonicalizePath(match[2]);
      if (!PLAUSIBLE_ROUTE_PATH_RE.test(path)) {
        continue;
      }
      endpoints.push({
        method: match[1] as HttpMethod,
        path,
        source,
        line: i + 1,
        format: "inline-code",
      });
    }
  }
  return endpoints;
}

function parseDocsFile(absPath: string): DocumentedEndpoint[] {
  return parseMarkdownEndpoints(
    readFileSync(absPath, "utf8"),
    relative(REPO_ROOT, absPath)
  );
}

/**
 * Collapse every dynamic segment (`{x}`, `[x]`, `[...x]`, `{...x}`) to a
 * stable wildcard so /api/runs/{id} and /api/runs/[executionId] hash to
 * the same shape. Static segments are preserved verbatim.
 *
 * Catch-alls collapse to `**` rather than `*`. Both spellings are matched:
 * indexRouteFiles rewrites `[...slug]` to `{...slug}` before shaping, so
 * only checking the bracket form would silently shape every catch-all as
 * an ordinary parameter.
 */
function pathShape(p: string): string {
  return p
    .split("/")
    .map((seg) => {
      if (/^\[\.\.\..+\]$/u.test(seg) || /^\{\.\.\..+\}$/u.test(seg)) {
        return "**";
      }
      if (/^\[.+\]$/u.test(seg) || /^\{.+\}$/u.test(seg)) {
        return "*";
      }
      return seg;
    })
    .join("/");
}

/**
 * Walk app/api/**.route.ts(x) once and return:
 *   shapeIndex: path-shape -> route file (repo-relative)
 *   catchAlls:  prefix-shape -> route file, for [...slug] segments
 *   routeFiles: list of (absPath, route URL with {param} placeholders)
 */
function indexRouteFiles(): {
  shapeIndex: Map<string, string>;
  catchAlls: { prefixShape: string; rel: string }[];
  routeFiles: { abs: string; routePath: string }[];
} {
  const shapeIndex = new Map<string, string>();
  const catchAlls: { prefixShape: string; rel: string }[] = [];
  const routeFiles: { abs: string; routePath: string }[] = [];
  const files = walkFiles(APP_API_DIR, "route.ts").concat(
    walkFiles(APP_API_DIR, "route.tsx")
  );
  for (const abs of files) {
    // Normalised once, at the single point where a repo-relative route
    // path enters the program: DELEGATED_CATCH_ALL_ROUTES is written with
    // forward slashes, and comparing it against a raw relative() result
    // never matches on Windows.
    const rel = relative(REPO_ROOT, abs).replace(/\\/gu, "/");
    const routePath =
      "/" +
      rel
        .replace(/^app\//u, "")
        .replace(/\/route\.tsx?$/u, "")
        .split("/")
        .map((seg) => seg.replace(/^\[(.+)\]$/u, "{$1}"))
        .join("/");
    routeFiles.push({ abs, routePath });
    const shape = pathShape(routePath);
    // First write wins; if two route files collide on shape (e.g.
    // `/api/workflow/{id}` and `/api/workflows/{id}` both collapse to
    // `/api/workflows/*` only if both literal segments match, which is
    // not the case here), the later one is silently ignored. The
    // un-documented warning pass surfaces any duplicate that mattered.
    if (!shapeIndex.has(shape)) {
      shapeIndex.set(shape, rel);
    }
    if (shape.endsWith("/**") && DELEGATED_CATCH_ALL_ROUTES.includes(rel)) {
      catchAlls.push({ prefixShape: shape.slice(0, -"/**".length), rel });
    }
  }
  return { shapeIndex, catchAlls, routeFiles };
}

/**
 * Resolve a documented path to the route file that would serve it.
 *
 * An exact shape match wins. Otherwise the path falls through to the
 * nearest allowlisted catch-all (see DELEGATED_CATCH_ALL_ROUTES), which is
 * what the App Router itself does: Better Auth serves every /api/auth/*
 * path from app/api/auth/[...all]/route.ts, so a page documenting
 * POST /api/auth/siwe/nonce is not drift even though no file bears that
 * name.
 */
function resolveRouteFile(
  path: string,
  shapeIndex: Map<string, string>,
  catchAlls: { prefixShape: string; rel: string }[]
): string | null {
  const shape = pathShape(path);
  const exact = shapeIndex.get(shape);
  if (exact) {
    return exact;
  }
  let best: { prefixShape: string; rel: string } | null = null;
  for (const candidate of catchAlls) {
    if (!shape.startsWith(`${candidate.prefixShape}/`)) {
      continue;
    }
    if (best === null || candidate.prefixShape.length > best.prefixShape.length) {
      best = candidate;
    }
  }
  return best?.rel ?? null;
}

/**
 * Returns true if the route file sets Content-Type: text/event-stream,
 * indicating a Server-Sent Events endpoint. The post-deploy curl probe
 * skips these: curl has no --max-time by default, so a keep-alive stream
 * blocks the probe indefinitely.
 */
function isStreamingRoute(absRouteFile: string): boolean {
  try {
    return readFileSync(absRouteFile, "utf8").includes("text/event-stream");
  } catch {
    return false;
  }
}

/**
 * Read a route file and report which HTTP methods it exports. Matches
 * the three styles observed in the codebase:
 *   export async function GET(...) { ... }
 *   export const GET = requireOrganization(async (req, ctx) => { ... });
 *   export { POST } from "@/app/api/.../route";
 */
function exportedMethods(absRouteFile: string): Set<HttpMethod> {
  const text = readFileSync(absRouteFile, "utf8");
  const found = new Set<HttpMethod>();
  for (const method of HTTP_METHODS) {
    const fn = new RegExp(
      String.raw`(?:^|\n)\s*export\s+(?:async\s+)?function\s+${method}\s*\(`,
      "u"
    );
    const cnst = new RegExp(
      String.raw`(?:^|\n)\s*export\s+const\s+${method}\s*=`,
      "u"
    );
    // export { GET } from "..."; or export { GET, POST } from "...";
    // Match within the braces of a re-export, allowing aliases (GET as Foo).
    const reExport = new RegExp(
      String.raw`(?:^|\n)\s*export\s*\{[^}]*\b${method}\b[^}]*\}\s*from\b`,
      "u"
    );
    if (fn.test(text) || cnst.test(text) || reExport.test(text)) {
      found.add(method);
    }
  }
  return found;
}

function countByFormat(endpoints: DocumentedEndpoint[]): string {
  const formats: EndpointFormat[] = [
    "http-fence",
    "inline-code",
    "code-sample",
  ];
  return formats
    .map(
      (format) =>
        `${format} ${endpoints.filter((ep) => ep.format === format).length}`
    )
    .join(", ");
}

function collectDocumentedEndpoints(): {
  endpoints: DocumentedEndpoint[];
  declared: DocumentedEndpoint[];
} {
  if (!existsSync(DOCS_DIR)) {
    throw new Error(`docs/api directory not found at ${DOCS_DIR}`);
  }
  const docFiles = walkFiles(DOCS_DIR, ".md");
  const all = docFiles.flatMap(parseDocsFile);
  // Deduplicate (a path may be re-mentioned in the same file, or in
  // several formats). Highest-priority format wins, document order breaks
  // ties, so an ```http fence keeps ownership of the entry it already had.
  const byPriority = all
    .map((endpoint, order) => ({ endpoint, order }))
    .sort(
      (a, b) =>
        FORMAT_PRIORITY[a.endpoint.format] - FORMAT_PRIORITY[b.endpoint.format] ||
        a.order - b.order
    )
    .map((entry) => entry.endpoint);
  const seen = new Set<string>();
  const out: DocumentedEndpoint[] = [];
  for (const ep of byPriority) {
    const key = `${ep.method} ${ep.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(ep);
  }
  return { endpoints: out, declared: all };
}

function validate(
  endpoints: DocumentedEndpoint[],
  shapeIndex: Map<string, string>,
  catchAlls: { prefixShape: string; rel: string }[]
): Drift[] {
  const drifts: Drift[] = [];
  for (const ep of endpoints) {
    const routeFile = resolveRouteFile(ep.path, shapeIndex, catchAlls);
    if (!routeFile) {
      drifts.push({
        kind: "missing-file",
        endpoint: ep,
        expectedShape: pathShape(ep.path),
      });
      continue;
    }
    const methods = exportedMethods(join(REPO_ROOT, routeFile));
    if (!methods.has(ep.method)) {
      drifts.push({ kind: "missing-method", endpoint: ep, routeFile });
    }
  }
  return drifts;
}

/**
 * Walk app/api/**.route.ts and flag routes that are not mentioned in any
 * docs/api/**.md file. Allowlisted prefixes (internal, cron, og, auth,
 * etc.) are skipped silently. Output is warn-only.
 */
function reportUndocumentedRoutes(
  documentedShapes: ReadonlySet<string>,
  routeFiles: { abs: string; routePath: string }[]
): string[] {
  const warnings: string[] = [];
  for (const { abs, routePath } of routeFiles) {
    // The catch-all itself - never warn on it.
    if (routePath === "/api/{...slug}") {
      continue;
    }
    if (UNDOCUMENTED_PREFIX_ALLOWLIST.some((p) => routePath.startsWith(p))) {
      continue;
    }
    if (!documentedShapes.has(pathShape(routePath))) {
      const rel = relative(REPO_ROOT, abs);
      warnings.push(`warn: ${routePath} (${rel}) is not mentioned in docs/api`);
    }
  }
  return warnings.sort();
}

function writeCoverageArtifact(
  endpoints: DocumentedEndpoint[],
  shapeIndex: Map<string, string>,
  catchAlls: { prefixShape: string; rel: string }[]
) {
  mkdirSync(dirname(COVERAGE_OUT), { recursive: true });
  // Stable ordering so the artifact diff is reviewable. Sort by raw code
  // point, NOT localeCompare: the committed file is byte-compared by the
  // CI drift check, and localeCompare's default collation depends on the
  // runtime locale/ICU, so a contributor whose machine sorts differently
  // from CI could regenerate a "stale" artifact that fails the build.
  const sorted = [...endpoints].sort((a, b) => {
    const ka = `${a.method} ${a.path}`;
    const kb = `${b.method} ${b.path}`;
    if (ka < kb) {
      return -1;
    }
    if (ka > kb) {
      return 1;
    }
    return 0;
  });
  const json = {
    endpoints: sorted.map((ep) => {
      const routeFile = resolveRouteFile(ep.path, shapeIndex, catchAlls);
      const streaming =
        routeFile !== null && isStreamingRoute(join(REPO_ROOT, routeFile));
      return {
        method: ep.method,
        path: ep.path,
        route_file: routeFile,
        ...(streaming ? { streaming: true } : {}),
        source: ep.source,
        line: ep.line,
      };
    }),
  };
  writeFileSync(COVERAGE_OUT, `${JSON.stringify(json, null, 2)}\n`);
}

function main(): number {
  const { endpoints, declared } = collectDocumentedEndpoints();
  const { shapeIndex, catchAlls, routeFiles } = indexRouteFiles();
  const drifts = validate(endpoints, shapeIndex, catchAlls);
  writeCoverageArtifact(endpoints, shapeIndex, catchAlls);

  console.log(
    `Scanned ${endpoints.length} documented endpoints across docs/api/`
  );
  // Two counts, because they answer different questions: the first says
  // which format owns each entry after dedup, the second says how much
  // each parser actually read. A format can legitimately own zero entries
  // while still checking dozens of declarations - a code sample calling a
  // route the prose already documents is exactly that case.
  console.log(`  entries by format: ${countByFormat(endpoints)}`);
  console.log(`  declarations read: ${countByFormat(declared)}`);

  if (drifts.length > 0) {
    // One endpoint can now be declared on several pages and in several
    // formats, and dedup keeps only one of them. Listing every site keeps
    // a drift report from sending the fixer to one page while an identical
    // stale mention sits on another.
    const sitesByKey = new Map<string, string[]>();
    for (const ep of declared) {
      const key = `${ep.method} ${ep.path}`;
      const site = `${ep.source}:${ep.line}`;
      const sites = sitesByKey.get(key) ?? [];
      if (!sites.includes(site)) {
        sites.push(site);
      }
      sitesByKey.set(key, sites);
    }
    console.error("\nDRIFT detected:\n");
    for (const d of drifts) {
      const { method, path, source, line } = d.endpoint;
      const reason =
        d.kind === "missing-file"
          ? `no route file matches the URL pattern ${d.expectedShape}`
          : `${d.routeFile} exists but does not export ${method}`;
      console.error(`  ${method} ${path}`);
      for (const site of sitesByKey.get(`${method} ${path}`) ?? [
        `${source}:${line}`,
      ]) {
        console.error(`    documented in ${site}`);
      }
      console.error(`    ${reason}`);
      // A page documenting a removal is a legitimate thing to write, and
      // the marker that says so is only discoverable here, at the moment
      // the author is looking at the failure.
      if (d.kind === "missing-file") {
        console.error(
          `    if the page is describing a removed endpoint on purpose, ` +
            `end that line with ${IGNORE_MARKER}`
        );
      }
      console.error("");
    }
  }

  const documentedShapes = new Set(endpoints.map((e) => pathShape(e.path)));
  const warnings = reportUndocumentedRoutes(documentedShapes, routeFiles);
  if (warnings.length > 0) {
    console.log(
      `\n${warnings.length} routes exist in code but are not in docs/api ` +
        "(warnings only):"
    );
    for (const w of warnings) {
      console.log(`  ${w}`);
    }
  }

  if (drifts.length > 0) {
    return 1;
  }
  console.log("\nNo docs-vs-code drift detected.");
  return 0;
}

// Only execute when run directly (not when imported in tests). Module
// identity, not the spelling of process.argv[1]: a CI gate that exits 0
// having checked nothing is worse than one that does not run at all, and
// every path-string comparison has an invocation that misses. Dropping the
// extension is enough to defeat both the suffix test this replaces and a
// `pathToFileURL(process.argv[1]).href` comparison.
if (require.main === module) {
  process.exit(main());
}
