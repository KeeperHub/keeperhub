#!/usr/bin/env tsx

/**
 * Plugin Auto-Discovery Script
 *
 * Automatically discovers all plugins in the plugins/ directory and generates
 * the plugins/index.ts file with imports. Also updates the README.md with
 * the current list of available actions.
 *
 * Plugin Allowlist (Optional):
 * - Create plugins/plugin-allowlist.json to control which plugins are enabled
 * - If the file doesn't exist, all discovered plugins are enabled
 * - This prevents disabled plugins from being registered while keeping them in the codebase
 *
 * Additionally generates codegen templates from step files that have
 * a stepHandler function.
 *
 * Run this script:
 * - Manually: pnpm discover-plugins
 * - Automatically: Before build (in package.json)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const PLUGINS_DIR = join(process.cwd(), "plugins");
const PROTOCOLS_DIR = join(process.cwd(), "protocols");
const OUTPUT_FILE = join(PLUGINS_DIR, "index.ts");
const TYPES_FILE = join(process.cwd(), "lib", "types", "integration.ts");
const STEP_REGISTRY_FILE = join(process.cwd(), "lib", "step-registry.ts");
const CREDENTIAL_MAP_FILE = join(process.cwd(), "lib", "credential-map.ts");
const OUTPUT_CONFIGS_FILE = join(
  process.cwd(),
  "lib",
  "output-display-configs.ts"
);
const CODEGEN_REGISTRY_FILE = join(process.cwd(), "lib", "workflow", "codegen", "registry.ts");
const README_FILE = join(process.cwd(), "README.md");
const PLUGIN_ALLOWLIST_FILE = join(
  process.cwd(),
  "plugins",
  "plugin-allowlist.json"
);
const PLUGINS_MARKER_REGEX =
  /<!-- PLUGINS:START[^>]*-->[\s\S]*?<!-- PLUGINS:END -->/;

// System integrations that don't have plugins
const SYSTEM_INTEGRATION_TYPES = ["database"] as const;

// Protocol slugs registered during this run, used by generateStepRegistry()
let registeredProtocolSlugs: string[] = [];

// Protocol entries registered during this run, used by generateProtocolsIndexFile()
let registeredProtocolEntries: ProtocolEntry[] = [];

// Regex patterns for codegen template generation
const LEADING_WHITESPACE_PATTERN = /^\s*/;

/**
 * Discover protocol definition files in protocols/
 * Returns absolute file paths for all .ts files (excludes .d.ts, index.ts, _-prefixed, .-prefixed)
 */
export function discoverProtocols(): string[] {
  if (!existsSync(PROTOCOLS_DIR)) {
    return [];
  }

  const entries = readdirSync(PROTOCOLS_DIR);

  // A directory nobody has put a protocol in yet is a legitimate zero:
  // someone with no protocols must still be able to run the generator.
  if (entries.length === 0) {
    return [];
  }

  const result: string[] = [];

  for (const file of entries) {
    if (
      file.endsWith(".d.ts") ||
      file === "index.ts" ||
      file.startsWith("_") ||
      file.startsWith(".")
    ) {
      continue;
    }

    if (!file.endsWith(".ts")) {
      continue;
    }

    result.push(join(PROTOCOLS_DIR, file));
  }

  // The directory has entries but none of them survived the filter above --
  // the directory moved, got renamed, or the filter itself broke. Silently
  // returning zero here is how a generator writes an empty registry over 24
  // real protocols and exits 0; that is exactly the failure mode this
  // module exists to close off.
  if (result.length === 0) {
    throw new Error(
      `protocols/ has ${entries.length} entr${entries.length === 1 ? "y" : "ies"} but none of them is a protocol definition file ` +
        "(a .ts file other than index.ts, a .d.ts file, or an underscore/dot-prefixed name). " +
        "Check the directory contents before re-running."
    );
  }

  return result;
}

type ProtocolEntry = {
  slug: string;
  fileStem: string;
  definition: import("@/lib/protocol-registry").ProtocolDefinition;
};

/**
 * Load protocol definitions from discovered files
 * Each file must have a default export that is a ProtocolDefinition
 */
/** A protocol file that could not become a registry entry, and why. */
export type ProtocolFailure = { filePath: string; reason: string };

/**
 * Raised when at least one protocol file could not be loaded.
 *
 * Thrown rather than logged because the generated `protocols/index.ts` and
 * `lib/types/integration.ts` are tracked files, not build artefacts: writing a
 * registry that silently omits a protocol produces a plausible-looking diff
 * under a "DO NOT EDIT MANUALLY" header, which is how a deletion gets
 * committed. `lib/step-registry.ts` is gitignored and carries no such risk.
 */
export class ProtocolDiscoveryError extends Error {
  readonly failures: readonly ProtocolFailure[];

  constructor(failures: ProtocolFailure[]) {
    super(
      [
        `${failures.length} protocol file(s) could not be loaded.`,
        "protocols/index.ts and lib/types/integration.ts were left untouched.",
        ...failures.map((f) => `  - ${f.filePath}: ${f.reason}`),
      ].join("\n")
    );
    this.name = "ProtocolDiscoveryError";
    this.failures = failures;
  }
}

/** Seams for tests. Production passes nothing and gets the real filesystem. */
export type ProtocolLoadDeps = {
  discover?: () => string[];
  importProtocol?: (filePath: string) => Promise<unknown>;
};

export async function loadProtocolDefinitions(
  deps: ProtocolLoadDeps = {}
): Promise<ProtocolEntry[]> {
  const discover = deps.discover ?? discoverProtocols;
  const importProtocol =
    deps.importProtocol ??
    // Windows: a bare absolute path ("C:\\...") is not a valid ESM
    // specifier -- Node's loader rejects it with ERR_UNSUPPORTED_ESM_URL_SCHEME.
    ((filePath: string) => import(pathToFileURL(filePath).href));

  const filePaths = discover();

  if (filePaths.length === 0) {
    console.log("   No protocol definitions found in protocols/");
    return [];
  }

  // One rejection path for both ways a file can fail to become a registry
  // entry -- the import throwing, or a default export with no slug. Runs
  // concurrently: protocol modules have no import-time side effects
  // (registerProtocol runs later, from the returned array), so concurrency
  // does not change registration order, and Promise.allSettled preserves
  // the input order of filePaths in its results regardless of resolution
  // order.
  const settled = await Promise.allSettled(
    filePaths.map(async (filePath) => {
      const mod = (await importProtocol(filePath)) as {
        default?: import("@/lib/protocol-registry").ProtocolDefinition;
      };
      const definition = mod?.default;

      if (!definition?.slug) {
        throw new Error("no default export with a slug");
      }

      return {
        slug: definition.slug,
        fileStem: toFileStem(filePath),
        definition,
      };
    })
  );

  const failures: ProtocolFailure[] = settled.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ filePath: filePaths[index], reason: reasonOf(result.reason) }]
      : []
  );

  if (failures.length > 0) {
    throw new ProtocolDiscoveryError(failures);
  }

  const results: ProtocolEntry[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      console.log(
        `   Discovered protocol: ${result.value.slug} (${result.value.definition.name})`
      );
      results.push(result.value);
    }
  }

  return results;
}

/** Basename without the `.ts` extension, used as the barrel import specifier. */
function toFileStem(filePath: string): string {
  return basename(filePath, ".ts");
}

/** Normalise a Promise.allSettled rejection reason to a message string. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Register all discovered protocols as IntegrationPlugins
 * Populates registeredProtocolSlugs and registeredProtocolEntries for use by other functions
 */
async function registerProtocolPlugins(
  deps: ProtocolLoadDeps = {}
): Promise<string[]> {
  const { protocolToPlugin, registerProtocol } = await import("@/lib/protocol-registry");
  const { registerIntegration } = await import("../plugins/registry-core");

  const definitions = await loadProtocolDefinitions(deps);
  const slugs: string[] = [];

  for (const entry of definitions) {
    registerProtocol(entry.definition);
    const plugin = protocolToPlugin(entry.definition);
    registerIntegration(plugin);
    slugs.push(entry.slug);
  }

  registeredProtocolSlugs = slugs;
  registeredProtocolEntries = definitions;
  return slugs;
}

/**
 * Convert protocol slug to valid JavaScript variable name
 * Examples: "weth" -> "wethDef", "aave-v3" -> "aaveV3Def"
 */
function slugToVarName(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase()) + "Def";
}

/**
 * Generate protocols/index.ts barrel file
 * This file imports all protocol definitions and registers them at import time
 */
function generateProtocolsIndexFile(): void {
  const PROTOCOLS_INDEX_FILE = join(PROTOCOLS_DIR, "index.ts");

  if (registeredProtocolEntries.length === 0) {
    // Generate minimal file when no protocols exist
    const content = `/**
 * Protocol Definitions Index (Auto-Generated)
 *
 * This file is automatically generated by scripts/discover-plugins.ts
 * DO NOT EDIT MANUALLY - your changes will be overwritten!
 *
 * No protocol definitions found. Add .ts files to protocols/
 * and run: pnpm discover-plugins
 */

// No protocols registered
`;
    writeFileSync(PROTOCOLS_INDEX_FILE, content, "utf-8");
    console.log("Generated protocols/index.ts (empty)");
    return;
  }

  // Generate import statements
  const imports: string[] = [];
  const registrations: string[] = [];
  const slugList: string[] = [];

  for (const entry of registeredProtocolEntries) {
    const { slug, fileStem } = entry;
    const varName = slugToVarName(slug);
    imports.push(`import ${varName} from "./${fileStem}";`);
    registrations.push(`registerProtocol(${varName});`);
    // hubOnly protocols appear in Hub > Protocols but do not register
    // as an integration plugin. Their slug is owned by a separately
    // registered plugin in plugins/{slug}/ (e.g., hyperliquid).
    if (!entry.definition.hubOnly) {
      registrations.push(`registerIntegration(protocolToPlugin(${varName}));`);
    }
    slugList.push(slug);
  }

  const content = `/**
 * Protocol Definitions Index (Auto-Generated)
 *
 * This file is automatically generated by scripts/discover-plugins.ts
 * DO NOT EDIT MANUALLY - your changes will be overwritten!
 *
 * Imports all protocol definitions and registers them at import time.
 * This ensures the protocol registry is populated when the Next.js
 * server starts (via the plugin import chain).
 *
 * Registered protocols: ${slugList.join(", ")}
 */

import { protocolToPlugin, registerProtocol } from "@/lib/protocol-registry";
import { registerIntegration } from "@/plugins/registry-core";

${imports.join("\n")}

${registrations.join("\n")}
`;

  writeFileSync(PROTOCOLS_INDEX_FILE, content, "utf-8");
  console.log(`Generated protocols/index.ts with ${registeredProtocolEntries.length} protocol(s)`);
}

/**
 * Format TypeScript code using Prettier
 */
async function formatCode(code: string): Promise<string> {
  try {
    const prettier = await import("prettier");
    return await prettier.format(code, { parser: "typescript" });
  } catch (error) {
    console.warn("   Warning: Failed to format generated code:", error);
    return code;
  }
}

/**
 * Raised when the allowlist file exists but its content cannot be trusted:
 * unparsable JSON, or a document that does not match
 * plugins/plugin-allowlist.schema.json (missing "plugins", or "plugins" not
 * an array of unique strings).
 *
 * An absent file is not an error - it means no restriction was declared, and
 * every plugin stays enabled. A present-but-broken file means the operator's
 * intent is known and unreadable, which is exactly when guessing is worst:
 * silently falling back to "all plugins enabled" discards a stated
 * restriction, and silently falling back to "[]" disables everything the
 * operator meant to keep. Neither is a value the caller asked for, so the
 * script exits non-zero instead of guessing.
 */
export class PluginAllowlistError extends Error {
  constructor(
    readonly filePath: string,
    reason: string
  ) {
    super(`Invalid plugin allowlist at ${filePath}: ${reason}`);
    this.name = "PluginAllowlistError";
  }
}

/** Seams for tests. Production passes nothing and gets the real filesystem. */
export type PluginAllowlistDeps = {
  exists?: () => boolean;
  readFile?: () => string;
};

/**
 * Check the parsed document against the shape declared by
 * plugins/plugin-allowlist.schema.json ("required": ["plugins"], "plugins"
 * typed as an array of unique strings) by hand, rather than pulling in a
 * JSON-schema library for one file. `"plugins": []` is a valid document -
 * it means the operator deliberately wants nothing enabled - so only a
 * missing/malformed "plugins" key is rejected, not an empty one.
 */
function assertValidAllowlist(
  config: unknown,
  filePath: string
): asserts config is { plugins: string[] } {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new PluginAllowlistError(filePath, "document must be a JSON object");
  }

  if (!("plugins" in config)) {
    throw new PluginAllowlistError(
      filePath,
      'missing required property "plugins"'
    );
  }

  const { plugins } = config as { plugins: unknown };

  if (!Array.isArray(plugins)) {
    throw new PluginAllowlistError(filePath, '"plugins" must be an array');
  }

  if (!plugins.every((entry): entry is string => typeof entry === "string")) {
    throw new PluginAllowlistError(
      filePath,
      '"plugins" must be an array of strings'
    );
  }

  if (new Set(plugins).size !== plugins.length) {
    throw new PluginAllowlistError(
      filePath,
      '"plugins" must not contain duplicate entries'
    );
  }
}

/**
 * Load plugin allowlist from config file.
 * Returns null if the file doesn't exist (meaning all plugins enabled).
 * Throws PluginAllowlistError if the file exists but cannot be parsed, or
 * does not match plugins/plugin-allowlist.schema.json.
 */
export function loadPluginAllowlist(
  deps: PluginAllowlistDeps = {}
): string[] | null {
  const exists = deps.exists ?? (() => existsSync(PLUGIN_ALLOWLIST_FILE));
  const readFile =
    deps.readFile ?? (() => readFileSync(PLUGIN_ALLOWLIST_FILE, "utf-8"));

  if (!exists()) {
    return null; // No allowlist = all plugins enabled
  }

  let config: unknown;
  try {
    config = JSON.parse(readFile());
  } catch (error) {
    throw new PluginAllowlistError(
      PLUGIN_ALLOWLIST_FILE,
      error instanceof Error ? error.message : String(error)
    );
  }

  assertValidAllowlist(config, PLUGIN_ALLOWLIST_FILE);
  return config.plugins;
}

// Track generated codegen templates
const generatedCodegenTemplates = new Map<
  string,
  { template: string; integrationType: string }
>();

/**
 * Discover plugins from a specific directory
 */
function discoverPluginsFromDir(pluginsDir: string): string[] {
  if (!existsSync(pluginsDir)) {
    return [];
  }

  const entries = readdirSync(pluginsDir);

  return entries.filter((entry) => {
    // Skip special directories and files
    if (
      entry.startsWith("_") ||
      entry.startsWith(".") ||
      entry === "index.ts" ||
      entry === "registry.ts" ||
      entry.endsWith(".ts") ||
      entry.endsWith(".md")
    ) {
      return false;
    }

    // Only include directories
    const fullPath = join(pluginsDir, entry);
    try {
      return statSync(fullPath).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Discover all plugin directories (returns both all and enabled plugins)
 * Scans both plugins/ and plugins/ directories
 */
function discoverPlugins(): { all: string[]; enabled: string[] } {
  const allowlist = loadPluginAllowlist();
  const plugins = discoverPluginsFromDir(PLUGINS_DIR);

  let enabledPlugins = plugins;

  if (allowlist !== null) {
    enabledPlugins = plugins.filter((plugin) => allowlist.includes(plugin));

    const disabledCount = plugins.length - enabledPlugins.length;
    if (disabledCount > 0) {
      console.log(
        `   Allowlist enabled: ${disabledCount} plugin(s) filtered out`
      );
    }
  }

  return {
    all: plugins.sort(),
    enabled: enabledPlugins.sort(),
  };
}

/**
 * Generate the plugins/index.ts file (base plugins)
 */
function generateIndexFile(plugins: string[]): void {
  const imports = plugins.map((plugin) => `import "./${plugin}";`).join("\n");

  const content = `/**
 * Plugins Index (Auto-Generated)
 *
 * This file is automatically generated by scripts/discover-plugins.ts
 * DO NOT EDIT MANUALLY - your changes will be overwritten!
 *
 * To add a new integration:
 * 1. Create a new directory in plugins/ (e.g., plugins/my-integration/)
 * 2. Add your plugin files (index.tsx, steps/, codegen/, etc.)
 * 3. Run: pnpm discover-plugins (or it runs automatically on build)
 *
 * To remove an integration:
 * 1. Delete the plugin directory
 * 2. Run: pnpm discover-plugins (or it runs automatically on build)
 *
 * Discovered plugins: ${plugins.join(", ") || "none"}
 */

${imports || "// No plugins discovered"}
`;

  writeFileSync(OUTPUT_FILE, content, "utf-8");
}


/**
 * Update the README.md with the current list of actions
 */
async function updateReadme(): Promise<void> {
  // Import registry first, then plugins
  const { getAllIntegrations } = await import("../plugins/registry");

  // Dynamically import the plugins to populate the registry
  // This works because we already generated plugins/index.ts above
  try {
    await import("../plugins/index");
  } catch (error) {
    console.error("Error importing plugins in updateReadme:", error);
    throw error;
  }

  const integrations = getAllIntegrations();
  console.log(`[updateReadme] Found ${integrations.length} integration(s)`);

  if (integrations.length === 0) {
    console.log("No integrations found, skipping README update");
    return;
  }

  // Generate markdown list grouped by integration
  const actionsList = integrations
    .map((integration) => {
      const actionLabels = integration.actions.map((a) => a.label).join(", ");
      return `- **${integration.label}**: ${actionLabels}`;
    })
    .join("\n");

  // Read current README
  const readme = readFileSync(README_FILE, "utf-8");

  // Check if markers exist
  if (!readme.includes("<!-- PLUGINS:START")) {
    console.log("README markers not found, skipping README update");
    return;
  }

  // Replace content between markers
  const updated = readme.replace(
    PLUGINS_MARKER_REGEX,
    `<!-- PLUGINS:START - Do not remove. Auto-generated by discover-plugins -->\n${actionsList}\n<!-- PLUGINS:END -->`
  );

  writeFileSync(README_FILE, updated, "utf-8");
  console.log(`Updated README.md with ${integrations.length} integration(s)`);
}

/**
 * Generate the lib/types/integration.ts file with dynamic types
 * Takes discovered plugin names from both base and KeeperHub directories,
 * plus protocol slugs registered via registerProtocolPlugins()
 */
function generateTypesFile(
  plugins: string[],
  protocolSlugs: string[] = []
): void {
  // Ensure the types directory exists
  const typesDir = dirname(TYPES_FILE);
  if (!existsSync(typesDir)) {
    mkdirSync(typesDir, { recursive: true });
  }

  // Combine all plugin types with system types (dedupe in case of overlap)
  const allTypes = [
    ...new Set([
      ...plugins,
      ...protocolSlugs,
      ...SYSTEM_INTEGRATION_TYPES,
    ]),
  ].sort();

  // Generate the union type
  const unionType = allTypes.map((t) => `  | "${t}"`).join("\n");

  const content = `/**
 * Integration Types (Auto-Generated)
 *
 * This file is automatically generated by scripts/discover-plugins.ts
 * DO NOT EDIT MANUALLY - your changes will be overwritten!
 *
 * To add a new integration type:
 * 1. Create a plugin in plugins/ or plugins/ directory, OR
 * 2. Add a system integration to SYSTEM_INTEGRATION_TYPES in discover-plugins.ts
 * 3. Run: pnpm discover-plugins
 *
 * Generated types: ${allTypes.join(", ")}
 */

// Integration type union - plugins + system integrations
export type IntegrationType =
${unionType};

// Generic config type - plugins define their own keys via formFields[].configKey
export type IntegrationConfig = Record<string, string | boolean | undefined>;
`;

  writeFileSync(TYPES_FILE, content, "utf-8");
  console.log(
    `Generated lib/types/integration.ts with ${allTypes.length} type(s)`
  );
}

// ============================================================================
// Codegen Template Generation
// ============================================================================

/** Analysis result type for step file parsing */
type StepFileAnalysis = {
  hasExportCore: boolean;
  integrationType: string | null;
  coreFunction: {
    name: string;
    params: string;
    returnType: string;
    body: string;
  } | null;
  inputTypes: string[];
  imports: string[];
};

/** Create empty analysis result */
function createEmptyAnalysis(): StepFileAnalysis {
  return {
    hasExportCore: false,
    integrationType: null,
    coreFunction: null,
    inputTypes: [],
    imports: [],
  };
}

/** Process exported variable declarations */
function processExportedVariable(
  decl: ts.VariableDeclaration,
  result: StepFileAnalysis
): void {
  if (!ts.isIdentifier(decl.name)) {
    return;
  }

  const name = decl.name.text;
  const init = decl.initializer;

  if (name === "_integrationType" && init && ts.isStringLiteral(init)) {
    result.integrationType = init.text;
  }
}

/** Check if a type name should be included in exports */
function shouldIncludeType(typeName: string): boolean {
  return (
    typeName.endsWith("Result") ||
    typeName.endsWith("Credentials") ||
    typeName.endsWith("CoreInput")
  );
}

/** Check if an import should be included in exports */
function shouldIncludeImport(moduleSpec: string, importText: string): boolean {
  // Skip internal imports
  if (moduleSpec.startsWith("@/") || moduleSpec.startsWith(".")) {
    return false;
  }
  // Skip server-only import
  if (importText.includes("server-only")) {
    return false;
  }
  return true;
}

/** Extract function info from a function declaration */
function extractFunctionInfo(
  node: ts.FunctionDeclaration,
  sourceCode: string
): StepFileAnalysis["coreFunction"] {
  if (!(node.name && node.body)) {
    return null;
  }

  const params = node.parameters
    .map((p) => sourceCode.slice(p.pos, p.end).trim())
    .join(", ");

  const returnType = node.type
    ? sourceCode.slice(node.type.pos, node.type.end).trim()
    : "Promise<unknown>";

  const body = sourceCode.slice(node.body.pos, node.body.end).trim();

  return {
    name: node.name.text,
    params,
    returnType,
    body,
  };
}

/** Process variable statement node */
function processVariableStatement(
  node: ts.VariableStatement,
  result: StepFileAnalysis
): void {
  const isExported = node.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword
  );
  if (!isExported) {
    return;
  }

  for (const decl of node.declarationList.declarations) {
    processExportedVariable(decl, result);
  }
}

/** Process type alias node */
function processTypeAlias(
  node: ts.TypeAliasDeclaration,
  sourceCode: string,
  result: StepFileAnalysis
): void {
  if (shouldIncludeType(node.name.text)) {
    result.inputTypes.push(sourceCode.slice(node.pos, node.end).trim());
  }
}

/** Process import declaration node */
function processImportDeclaration(
  node: ts.ImportDeclaration,
  sourceCode: string,
  result: StepFileAnalysis
): void {
  const spec = node.moduleSpecifier;
  if (!ts.isStringLiteral(spec)) {
    return;
  }
  const importText = sourceCode.slice(node.pos, node.end).trim();
  if (shouldIncludeImport(spec.text, importText)) {
    result.imports.push(importText);
  }
}

/** Process a single AST node for exports, types, and imports */
function processNode(
  node: ts.Node,
  sourceCode: string,
  result: StepFileAnalysis
): void {
  if (ts.isVariableStatement(node)) {
    processVariableStatement(node, result);
    return;
  }

  if (ts.isTypeAliasDeclaration(node)) {
    processTypeAlias(node, sourceCode, result);
    return;
  }

  if (ts.isImportDeclaration(node)) {
    processImportDeclaration(node, sourceCode, result);
    return;
  }

  // Check for stepHandler function (doesn't need to be exported)
  if (ts.isFunctionDeclaration(node) && node.name?.text === "stepHandler") {
    result.hasExportCore = true;
    result.coreFunction = extractFunctionInfo(node, sourceCode);
  }
}

/**
 * Extract information about a step file's exports using TypeScript AST
 */
function analyzeStepFile(filePath: string): StepFileAnalysis {
  const result = createEmptyAnalysis();

  if (!existsSync(filePath)) {
    return result;
  }

  const sourceCode = readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.Latest,
    true
  );

  // Single pass: find stepHandler function, types, and imports
  ts.forEachChild(sourceFile, (node) => {
    processNode(node, sourceCode, result);
  });

  return result;
}

/**
 * Generate a codegen template from a step file's core function
 */
async function generateCodegenTemplate(
  stepFilePath: string,
  stepFunctionName: string
): Promise<string | null> {
  const analysis = analyzeStepFile(stepFilePath);

  if (!(analysis.hasExportCore && analysis.coreFunction)) {
    return null;
  }

  const { coreFunction, integrationType, inputTypes, imports } = analysis;

  // Extract the inner body (remove outer braces)
  let innerBody = coreFunction.body.trim();
  if (innerBody.startsWith("{")) {
    innerBody = innerBody.slice(1);
  }
  if (innerBody.endsWith("}")) {
    innerBody = innerBody.slice(0, -1);
  }
  innerBody = innerBody.trim();

  // Extract input type from first parameter
  const inputType =
    coreFunction.params
      .split(",")[0]
      .replace(LEADING_WHITESPACE_PATTERN, "")
      .split(":")[1]
      ?.trim() || "unknown";

  // Build the raw template (formatter will fix indentation)
  const rawTemplate = `${imports.join("\n")}
import { fetchCredentials } from './lib/credential-helper';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

${inputTypes.join("\n\n")}

export async function ${stepFunctionName}(input: ${inputType}): ${coreFunction.returnType} {
  "use step";
  const credentials = await fetchCredentials("${integrationType || "unknown"}");
${innerBody}
}`;

  // Format the generated code
  return await formatCode(rawTemplate);
}

/**
 * Process step files and generate codegen templates
 */
async function processStepFilesForCodegen(): Promise<void> {
  const { getAllIntegrations, computeActionId } = await import(
    "@/plugins/registry"
  );
  const integrations = getAllIntegrations();

  const protocolSlugSet = new Set(registeredProtocolSlugs);

  for (const integration of integrations) {
    // Protocol plugins delegate to shared core step files -- no codegen templates needed
    if (protocolSlugSet.has(integration.type)) {
      continue;
    }

    for (const action of integration.actions) {
      const stepFilePath = join(
        PLUGINS_DIR,
        integration.type,
        "steps",
        `${action.stepImportPath}.ts`
      );

      const template = await generateCodegenTemplate(
        stepFilePath,
        action.stepFunction
      );

      if (template) {
        const actionId = computeActionId(integration.type, action.slug);
        generatedCodegenTemplates.set(actionId, {
          template,
          integrationType: integration.type,
        });
        console.log(`   Generated codegen template for ${actionId}`);
      }
    }
  }
}

/**
 * Generate the lib/workflow/codegen/registry.ts file with auto-generated templates
 */
function generateCodegenRegistry(): void {
  const entries = Array.from(generatedCodegenTemplates.entries());

  if (entries.length === 0) {
    console.log("No codegen templates generated");
    return;
  }

  // Generate template string literals
  const templateEntries = entries
    .map(([actionId, { template }]) => {
      // Escape backticks and ${} in the template for safe embedding
      const escapedTemplate = template
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\$\{/g, "\\${");
      return `  "${actionId}": \`${escapedTemplate}\`,`;
    })
    .join("\n\n");

  const content = `/**
 * Codegen Registry (Auto-Generated)
 *
 * This file is automatically generated by scripts/discover-plugins.ts
 * DO NOT EDIT MANUALLY - your changes will be overwritten!
 *
 * Contains auto-generated codegen templates for steps with stepHandler.
 * These templates are used when exporting workflows to standalone projects.
 *
 * Generated templates: ${entries.length}
 */

/**
 * Auto-generated codegen templates
 * Maps action IDs to their generated export code templates
 */
export const AUTO_GENERATED_TEMPLATES: Record<string, string> = {
${templateEntries}
};

/**
 * Get the auto-generated codegen template for an action
 */
export function getAutoGeneratedTemplate(actionId: string): string | undefined {
  return AUTO_GENERATED_TEMPLATES[actionId];
}
`;

  writeFileSync(CODEGEN_REGISTRY_FILE, content, "utf-8");
  console.log(
    `Generated lib/workflow/codegen/registry.ts with ${entries.length} template(s)`
  );
}

// ============================================================================
// Step Registry Generation
// ============================================================================

/**
 * Generate the lib/step-registry.ts file with step import functions
 * This enables dynamic imports that are statically analyzable by the bundler
 */
async function generateStepRegistry(): Promise<void> {
  // Import registry FIRST - this is critical! Plugins need the registry to exist before they register
  const registryModule = await import("../plugins/registry");
  const { getAllIntegrations, computeActionId } = registryModule;

  // Import plugins to trigger registration (they will use the registry we just imported)
  try {
    await import("../plugins/index");
  } catch (error) {
    console.error("Error importing plugins:", error);
    throw error;
  }

  const { LEGACY_ACTION_MAPPINGS } = await import("../plugins/legacy-mappings");
  const integrations = getAllIntegrations();
  console.log(
    `[generateStepRegistry] Found ${integrations.length} integration(s) with ${integrations.reduce((sum, i) => sum + i.actions.length, 0)} total action(s)`
  );

  // Collect all action -> step mappings
  const stepEntries: Array<{
    actionId: string;
    label: string;
    integration: string;
    stepImportPath: string;
    stepFunction: string;
    outputConfig?: { type: string; field: string };
  }> = [];

  for (const integration of integrations) {
    for (const action of integration.actions) {
      const fullActionId = computeActionId(integration.type, action.slug);
      stepEntries.push({
        actionId: fullActionId,
        label: action.label,
        integration: integration.type,
        stepImportPath: action.stepImportPath,
        stepFunction: action.stepFunction,
        outputConfig: action.outputConfig,
      });
    }
  }

  // Build reverse mapping from action IDs to legacy labels
  const legacyLabelsForAction: Record<string, string[]> = {};
  for (const [legacyLabel, actionId] of Object.entries(
    LEGACY_ACTION_MAPPINGS
  )) {
    if (!legacyLabelsForAction[actionId]) {
      legacyLabelsForAction[actionId] = [];
    }
    legacyLabelsForAction[actionId].push(legacyLabel);
  }

  // Generate the step importer map with static imports
  // Include both namespaced IDs and legacy label-based IDs for backward compatibility
  const protocolSlugSet = new Set(registeredProtocolSlugs);
  const importerEntries = stepEntries
    .flatMap(({ actionId, integration, stepImportPath, stepFunction }) => {
      // Protocol plugins are virtual -- step files live in plugins/protocol/steps/
      // regardless of which protocol they serve (e.g. weth, aave, etc.)
      // Actions injected from non-protocol plugins (e.g. safe/get-pending-transactions)
      // use their own step files, detected by stepImportPath not starting with "protocol-".
      let importPath: string;
      const isProtocolStep =
        protocolSlugSet.has(integration) &&
        stepImportPath.startsWith("protocol-");
      if (isProtocolStep) {
        importPath = `@/plugins/protocol/steps/${stepImportPath}`;
      } else {
        importPath = `@/plugins/${integration}/steps/${stepImportPath}`;
      }
      const entries = [
        `  "${actionId}": {
    importer: () => import("${importPath}"),
    stepFunction: "${stepFunction}",
  },`,
      ];
      // Add entries for all legacy labels that map to this action
      const legacyLabels = legacyLabelsForAction[actionId] ?? [];
      for (const legacyLabel of legacyLabels) {
        entries.push(
          `  "${legacyLabel}": {
    importer: () => import("${importPath}"),
    stepFunction: "${stepFunction}",
  },`
        );
      }
      return entries;
    })
    .join("\n");

  // Generate the action labels map for displaying human-readable names
  const labelEntries = stepEntries
    .map(({ actionId, label }) => `  "${actionId}": "${label}",`)
    .join("\n");

  // Also add legacy label mappings to the labels map
  const legacyLabelEntries = Object.entries(legacyLabelsForAction)
    .flatMap(([actionId, legacyLabels]) => {
      const entry = stepEntries.find((e) => e.actionId === actionId);
      if (!entry) {
        return [];
      }
      return legacyLabels.map(
        (legacyLabel) => `  "${legacyLabel}": "${entry.label}",`
      );
    })
    .join("\n");

  const content = `/**
 * Step Registry (Auto-Generated)
 *
 * This file is automatically generated by scripts/discover-plugins.ts
 * DO NOT EDIT MANUALLY - your changes will be overwritten!
 *
 * This registry enables dynamic step imports that are statically analyzable
 * by the bundler. Each action type maps to its step importer function.
 *
 * Generated entries: ${stepEntries.length}
 */

import "server-only";

// biome-ignore lint/suspicious/noExplicitAny: Dynamic step module types - step functions take any input
export type StepFunction = (input: any) => Promise<any>;

// Step modules may contain the step function plus other exports (types, constants, etc.)
// biome-ignore lint/suspicious/noExplicitAny: Dynamic module with mixed exports
export type StepModule = Record<string, any>;

export type StepImporter = {
  importer: () => Promise<StepModule>;
  stepFunction: string;
};

/**
 * Plugin step importers - maps action types to their step import functions
 * These imports are statically analyzable by the bundler
 */
export const PLUGIN_STEP_IMPORTERS: Record<string, StepImporter> = {
${importerEntries}
};

/**
 * Action labels - maps action IDs to human-readable labels
 * Used for displaying friendly names in the UI (e.g., Runs tab)
 */
export const ACTION_LABELS: Record<string, string> = {
${labelEntries}
${legacyLabelEntries}
};

/**
 * Get a step importer for an action type
 */
export function getStepImporter(actionType: string): StepImporter | undefined {
  return PLUGIN_STEP_IMPORTERS[actionType];
}

/**
 * Get the human-readable label for an action type
 */
export function getActionLabel(actionType: string): string | undefined {
  return ACTION_LABELS[actionType];
}
`;

  writeFileSync(STEP_REGISTRY_FILE, content, "utf-8");
  console.log(
    `Generated lib/step-registry.ts with ${stepEntries.length} step(s)`
  );
}

/**
 * Generate the lib/credential-map.ts file with a static configKey -> envVar
 * map for every plugin formField that has both. The map is statically
 * importable by the credential fetcher so Workflow DevKit step bundles, where
 * dynamic require("@/plugins") fails, can still resolve the right credential
 * key without falling back to raw config keys.
 */
async function generateCredentialMap(): Promise<void> {
  const { getAllIntegrations } = await import("@/plugins/registry");
  const integrations = getAllIntegrations();

  const lines: string[] = [];
  let totalFields = 0;
  for (const integration of integrations) {
    const pairs: string[] = [];
    for (const field of integration.formFields) {
      if (field.envVar && field.configKey) {
        pairs.push(`    ${JSON.stringify(field.configKey)}: ${JSON.stringify(field.envVar)},`);
        totalFields++;
      }
    }
    if (pairs.length > 0) {
      lines.push(`  ${JSON.stringify(integration.type)}: {`);
      lines.push(...pairs);
      lines.push("  },");
    }
  }

  const content = `/**
 * Credential Map (Auto-Generated)
 *
 * This file is automatically generated by scripts/discover-plugins.ts
 * DO NOT EDIT MANUALLY - your changes will be overwritten!
 *
 * Maps each integration type to its formField configKey -> envVar mapping.
 * Used by lib/credential-fetcher.ts so that the credential keys exposed to
 * step files (e.g. credentials.TELEGRAM_BOT_TOKEN) can be resolved even when
 * the runtime plugin registry is unavailable - notably inside Workflow DevKit
 * step bundles, where the plugin registry import chain is not pulled in.
 *
 * Generated entries: ${integrations.length} plugin(s), ${totalFields} field(s)
 */

import "server-only";

export const PLUGIN_CREDENTIAL_MAP: Record<
  string,
  Record<string, string>
> = {
${lines.join("\n")}
};
`;

  writeFileSync(CREDENTIAL_MAP_FILE, content, "utf-8");
  console.log(
    `Generated lib/credential-map.ts with ${integrations.length} plugin(s), ${totalFields} field(s)`
  );
}

/**
 * Generate the lib/output-display-configs.ts file (client-safe)
 * This file can be imported in client components
 */
async function generateOutputDisplayConfigs(): Promise<void> {
  const { getAllIntegrations, computeActionId } = await import(
    "@/plugins/registry"
  );
  const integrations = getAllIntegrations();

  // Collect output configs
  const outputConfigs: Array<{
    actionId: string;
    type: string;
    field: string;
  }> = [];

  for (const integration of integrations) {
    for (const action of integration.actions) {
      if (action.outputConfig) {
        outputConfigs.push({
          actionId: computeActionId(integration.type, action.slug),
          type: action.outputConfig.type,
          field: action.outputConfig.field,
        });
      }
    }
  }

  // Generate output config entries
  const outputConfigEntries = outputConfigs
    .map(
      ({ actionId, type, field }) =>
        `  "${actionId}": { type: "${type}", field: "${field}" },`
    )
    .join("\n");

  const content = `/**
 * Output Display Configs (Auto-Generated)
 *
 * This file is automatically generated by scripts/discover-plugins.ts
 * DO NOT EDIT MANUALLY - your changes will be overwritten!
 *
 * This file is CLIENT-SAFE and can be imported in client components.
 * It maps action IDs to their output display configuration.
 *
 * Generated configs: ${outputConfigs.length}
 */

export type OutputDisplayConfig = {
  type: "image" | "video" | "url";
  field: string;
};

/**
 * Output display configs - maps action IDs to their display configuration
 * Used for rendering outputs in the workflow runs panel
 */
export const OUTPUT_DISPLAY_CONFIGS: Record<string, OutputDisplayConfig> = {
${outputConfigEntries}
};

/**
 * Get the output display config for an action type
 */
export function getOutputDisplayConfig(actionType: string): OutputDisplayConfig | undefined {
  return OUTPUT_DISPLAY_CONFIGS[actionType];
}
`;

  writeFileSync(OUTPUT_CONFIGS_FILE, content, "utf-8");
  console.log(
    `Generated lib/output-display-configs.ts with ${outputConfigs.length} config(s)`
  );
}

/**
 * Main execution
 */
export async function main(deps: ProtocolLoadDeps = {}): Promise<void> {
  console.log("Discovering plugins...");

  const plugins = discoverPlugins();

  if (plugins.all.length === 0) {
    console.log("No plugins found in plugins/ directory");
  } else {
    console.log(`\nPlugins (${plugins.enabled.length} enabled):`);
    for (const plugin of plugins.enabled) {
      console.log(`   - ${plugin}`);
    }
    if (plugins.all.length > plugins.enabled.length) {
      const disabledPlugins = plugins.all.filter(
        (p) => !plugins.enabled.includes(p)
      );
      console.log(`   Disabled: ${disabledPlugins.join(", ")}`);
    }
  }

  // Protocols are loaded and registered before anything is written to disk.
  // A failed load throws ProtocolDiscoveryError here, ahead of
  // generateIndexFile()'s write to plugins/index.ts, so a bad protocol file
  // leaves the whole tree untouched instead of half-regenerated. This also
  // keeps protocols registered before plugins/index.ts is imported (in
  // updateReadme() and generateStepRegistry() below), so that plugins which
  // inject actions into protocol integrations (e.g. safe plugin -> safe
  // protocol) can find the integration in the registry at import time --
  // running the load first satisfies both constraints at once.
  console.log("Registering protocol plugins...");
  const protocolSlugs = await registerProtocolPlugins(deps);
  console.log(`Registered ${protocolSlugs.length} protocol(s)`);

  console.log("Generating plugins/index.ts...");
  generateIndexFile(plugins.enabled);

  console.log("Generating protocols/index.ts...");
  generateProtocolsIndexFile();

  console.log("Updating README.md...");
  await updateReadme();

  console.log("\nGenerating lib/types/integration.ts...");
  generateTypesFile(plugins.all, protocolSlugs);

  console.log("Generating lib/step-registry.ts...");
  await generateStepRegistry();

  console.log("Generating lib/credential-map.ts...");
  await generateCredentialMap();

  console.log("Generating lib/output-display-configs.ts...");
  await generateOutputDisplayConfigs();

  console.log("\nProcessing step files for codegen templates...");
  await processStepFilesForCodegen();

  console.log("Generating lib/workflow/codegen/registry.ts...");
  generateCodegenRegistry();

  console.log("Done! Plugin registry updated.\n");
}

// Only when run directly, so a test can import loadPluginAllowlist or
// loadProtocolDefinitions without regenerating the tree.
// `require.main === module` rather than a
// `process.argv[1]` suffix test - scripts/check-api-docs-routes.ts records why
// identity beats comparing path spellings.
if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}
