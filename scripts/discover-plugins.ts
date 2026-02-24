#!/usr/bin/env tsx

/**
 * Plugin Auto-Discovery Script
 *
 * Automatically discovers all plugins in the plugins/ directory and generates
 * the plugins/index.ts file with imports. Also updates the README.md with
 * the current list of available actions.
 *
 * Plugin Allowlist (Optional):
 * - Create config/plugin-allowlist.json to control which plugins are enabled
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
import ts from "typescript";

const PLUGINS_DIR = join(process.cwd(), "plugins");
const KEEPERHUB_PLUGINS_DIR = join(process.cwd(), "keeperhub", "plugins");
const PROTOCOLS_DIR = join(process.cwd(), "keeperhub", "protocols");
const OUTPUT_FILE = join(PLUGINS_DIR, "index.ts");
const KEEPERHUB_OUTPUT_FILE = join(KEEPERHUB_PLUGINS_DIR, "index.ts");
const TYPES_FILE = join(process.cwd(), "lib", "types", "integration.ts");
const STEP_REGISTRY_FILE = join(process.cwd(), "lib", "step-registry.ts");
const OUTPUT_CONFIGS_FILE = join(
  process.cwd(),
  "lib",
  "output-display-configs.ts"
);
const CODEGEN_REGISTRY_FILE = join(process.cwd(), "lib", "codegen-registry.ts");
const README_FILE = join(process.cwd(), "README.md");
const PLUGIN_ALLOWLIST_FILE = join(
  process.cwd(),
  "config",
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
 * Discover protocol definition files in keeperhub/protocols/
 * Returns absolute file paths for all .ts files (excludes .d.ts, index.ts, _-prefixed, .-prefixed)
 */
function discoverProtocols(): string[] {
  if (!existsSync(PROTOCOLS_DIR)) {
    return [];
  }

  const files = readdirSync(PROTOCOLS_DIR);
  const result: string[] = [];

  for (const file of files) {
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

  return result;
}

type ProtocolEntry = {
  slug: string;
  fileStem: string;
  definition: import("../keeperhub/lib/protocol-registry").ProtocolDefinition;
};

/**
 * Load protocol definitions from discovered files
 * Each file must have a default export that is a ProtocolDefinition
 */
async function loadProtocolDefinitions(): Promise<ProtocolEntry[]> {
  const filePaths = discoverProtocols();

  if (filePaths.length === 0) {
    console.log("   No protocol definitions found in keeperhub/protocols/");
    return [];
  }

  const results: ProtocolEntry[] = [];

  for (const filePath of filePaths) {
    try {
      const mod = await import(filePath);
      const definition =
        mod.default as import("../keeperhub/lib/protocol-registry").ProtocolDefinition;

      if (!definition?.slug) {
        console.warn(
          `   Warning: ${filePath} has no default export with a slug, skipping`
        );
        continue;
      }

      const fileStem = basename(filePath, ".ts");

      console.log(
        `   Discovered protocol: ${definition.slug} (${definition.name})`
      );
      results.push({ slug: definition.slug, fileStem, definition });
    } catch (error) {
      console.warn(
        `   Warning: Failed to import protocol from ${filePath}:`,
        error
      );
    }
  }

  return results;
}

/**
 * Register all discovered protocols as IntegrationPlugins
 * Populates registeredProtocolSlugs and registeredProtocolEntries for use by other functions
 */
async function registerProtocolPlugins(): Promise<string[]> {
  const { protocolToPlugin, registerProtocol } = await import("../keeperhub/lib/protocol-registry");
  const { registerIntegration } = await import("../plugins/registry");

  const definitions = await loadProtocolDefinitions();
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
 * Generate keeperhub/protocols/index.ts barrel file
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
 * No protocol definitions found. Add .ts files to keeperhub/protocols/
 * and run: pnpm discover-plugins
 */

// No protocols registered
`;
    writeFileSync(PROTOCOLS_INDEX_FILE, content, "utf-8");
    console.log("Generated keeperhub/protocols/index.ts (empty)");
    return;
  }

  // Generate import statements
  const imports: string[] = [];
  const registrations: string[] = [];
  const slugList: string[] = [];

  for (const { slug, fileStem } of registeredProtocolEntries) {
    const varName = slugToVarName(slug);
    imports.push(`import ${varName} from "./${fileStem}";`);
    registrations.push(`registerProtocol(${varName});`);
    registrations.push(`registerIntegration(protocolToPlugin(${varName}));`);
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

import {
  protocolToPlugin,
  registerProtocol,
} from "@/keeperhub/lib/protocol-registry";
import { registerIntegration } from "@/plugins/registry";

${imports.join("\n")}

${registrations.join("\n")}
`;

  writeFileSync(PROTOCOLS_INDEX_FILE, content, "utf-8");
  console.log(`Generated keeperhub/protocols/index.ts with ${registeredProtocolEntries.length} protocol(s)`);
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
 * Load plugin allowlist from config file
 * Returns null if config doesn't exist (meaning all plugins enabled)
 */
function loadPluginAllowlist(): string[] | null {
  if (!existsSync(PLUGIN_ALLOWLIST_FILE)) {
    return null; // No allowlist = all plugins enabled
  }

  try {
    const content = readFileSync(PLUGIN_ALLOWLIST_FILE, "utf-8");
    const config = JSON.parse(content);
    return config.plugins || [];
  } catch (error) {
    console.warn(`   Warning: Failed to load plugin allowlist: ${error}`);
    return null; // Fallback to all plugins on error
  }
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
 * Scans both plugins/ and keeperhub/plugins/ directories
 */
function discoverPlugins(): {
  base: { all: string[]; enabled: string[] };
  keeperhub: { all: string[]; enabled: string[] };
} {
  const allowlist = loadPluginAllowlist();

  // Discover base plugins
  const basePlugins = discoverPluginsFromDir(PLUGINS_DIR);
  // Discover KeeperHub plugins
  const keeperhubPlugins = discoverPluginsFromDir(KEEPERHUB_PLUGINS_DIR);

  let enabledBasePlugins = basePlugins;
  let enabledKeeperHubPlugins = keeperhubPlugins;

  // Apply allowlist filter if config exists
  if (allowlist !== null) {
    enabledBasePlugins = basePlugins.filter((plugin) =>
      allowlist.includes(plugin)
    );
    enabledKeeperHubPlugins = keeperhubPlugins.filter((plugin) =>
      allowlist.includes(plugin)
    );

    const disabledCount =
      basePlugins.length +
      keeperhubPlugins.length -
      enabledBasePlugins.length -
      enabledKeeperHubPlugins.length;

    if (disabledCount > 0) {
      console.log(
        `   Allowlist enabled: ${disabledCount} plugin(s) filtered out`
      );
    }
  }

  return {
    base: {
      all: basePlugins.sort(),
      enabled: enabledBasePlugins.sort(),
    },
    keeperhub: {
      all: keeperhubPlugins.sort(),
      enabled: enabledKeeperHubPlugins.sort(),
    },
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

// Import KeeperHub custom plugins
import "@/keeperhub/plugins";

export type {
  ActionConfigField,
  ActionConfigFieldBase,
  ActionConfigFieldGroup,
  ActionWithFullId,
  IntegrationPlugin,
  PluginAction,
} from "./registry";

// Export the registry utilities
export {
  computeActionId,
  findActionById,
  flattenConfigFields,
  generateAIActionPrompts,
  getActionsByCategory,
  getAllActions,
  getAllDependencies,
  getAllEnvVars,
  getAllIntegrations,
  getCredentialMapping,
  getDependenciesForActions,
  getIntegration,
  getIntegrationLabels,
  getIntegrationTypes,
  getPluginEnvVars,
  getSortedIntegrationTypes,
  isFieldGroup,
  parseActionId,
  registerIntegration,
} from "./registry";
`;

  writeFileSync(OUTPUT_FILE, content, "utf-8");
}

/**
 * Generate the keeperhub/plugins/index.ts file (KeeperHub-specific plugins)
 */
function generateKeeperHubIndexFile(plugins: string[]): void {
  const imports = plugins.map((plugin) => `import "./${plugin}";`).join("\n");

  const content = `/**
 * KeeperHub Plugins Index (Auto-Generated)
 *
 * This file is automatically generated by scripts/discover-plugins.ts
 * DO NOT EDIT MANUALLY - your changes will be overwritten!
 *
 * KeeperHub-specific plugins that extend the base workflow builder.
 * These plugins are loaded in addition to the base plugins.
 *
 * Discovered plugins: ${plugins.join(", ") || "none"}
 */

${imports || "// No KeeperHub plugins discovered"}

// Re-export types from base registry for convenience
export type {
  ActionConfigField,
  ActionConfigFieldBase,
  ActionConfigFieldGroup,
  ActionWithFullId,
  IntegrationPlugin,
  PluginAction,
} from "@/plugins/registry";

export {
  computeActionId,
  findActionById,
  flattenConfigFields,
  generateAIActionPrompts,
  getActionsByCategory,
  getAllActions,
  getAllDependencies,
  getAllEnvVars,
  getAllIntegrations,
  getCredentialMapping,
  getDependenciesForActions,
  getIntegration,
  getIntegrationLabels,
  getIntegrationTypes,
  getPluginEnvVars,
  getSortedIntegrationTypes,
  isFieldGroup,
  parseActionId,
  registerIntegration,
} from "@/plugins/registry";
`;

  writeFileSync(KEEPERHUB_OUTPUT_FILE, content, "utf-8");
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
  basePlugins: string[],
  keeperhubPlugins: string[],
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
      ...basePlugins,
      ...keeperhubPlugins,
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
 * 1. Create a plugin in plugins/ or keeperhub/plugins/ directory, OR
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

  // Determine which plugins are in KeeperHub vs base
  const keeperhubPluginNames = discoverPluginsFromDir(KEEPERHUB_PLUGINS_DIR);
  const keeperhubPluginSet = new Set(keeperhubPluginNames);
  const protocolSlugSet = new Set(registeredProtocolSlugs);

  for (const integration of integrations) {
    // Protocol plugins delegate to shared core step files -- no codegen templates needed
    if (protocolSlugSet.has(integration.type)) {
      continue;
    }

    // Determine the correct plugins directory
    const pluginsDir = keeperhubPluginSet.has(integration.type)
      ? KEEPERHUB_PLUGINS_DIR
      : PLUGINS_DIR;

    for (const action of integration.actions) {
      const stepFilePath = join(
        pluginsDir,
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
 * Generate the lib/codegen-registry.ts file with auto-generated templates
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
    `Generated lib/codegen-registry.ts with ${entries.length} template(s)`
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

  // Determine which plugins are in KeeperHub vs base
  const keeperhubPluginNames = discoverPluginsFromDir(KEEPERHUB_PLUGINS_DIR);
  const keeperhubPluginSet = new Set(keeperhubPluginNames);

  // Generate the step importer map with static imports
  // Include both namespaced IDs and legacy label-based IDs for backward compatibility
  const protocolSlugSet = new Set(registeredProtocolSlugs);
  const importerEntries = stepEntries
    .flatMap(({ actionId, integration, stepImportPath, stepFunction }) => {
      // Protocol plugins are virtual -- step files live in keeperhub/plugins/protocol/steps/
      // regardless of which protocol they serve (e.g. weth, aave, etc.)
      // Actions injected from non-protocol plugins (e.g. safe/get-pending-transactions)
      // use their own step files, detected by stepImportPath not starting with "protocol-".
      let importPath: string;
      const isProtocolStep =
        protocolSlugSet.has(integration) &&
        stepImportPath.startsWith("protocol-");
      if (isProtocolStep) {
        importPath = `@/keeperhub/plugins/protocol/steps/${stepImportPath}`;
      } else {
        const importBase = keeperhubPluginSet.has(integration)
          ? "@/keeperhub/plugins"
          : "@/plugins";
        importPath = `${importBase}/${integration}/steps/${stepImportPath}`;
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
async function main(): Promise<void> {
  console.log("Discovering plugins...");

  const { base, keeperhub } = discoverPlugins();

  // Report base plugins
  if (base.all.length === 0) {
    console.log("No base plugins found in plugins/ directory");
  } else {
    console.log(`\nBase plugins (${base.enabled.length} enabled):`);
    for (const plugin of base.enabled) {
      console.log(`   - ${plugin}`);
    }
    if (base.all.length > base.enabled.length) {
      const disabledPlugins = base.all.filter((p) => !base.enabled.includes(p));
      console.log(`   Disabled: ${disabledPlugins.join(", ")}`);
    }
  }

  // Report KeeperHub plugins
  if (keeperhub.all.length === 0) {
    console.log("\nNo KeeperHub plugins found in keeperhub/plugins/ directory");
  } else {
    console.log(`\nKeeperHub plugins (${keeperhub.enabled.length} enabled):`);
    for (const plugin of keeperhub.enabled) {
      console.log(`   - ${plugin}`);
    }
    if (keeperhub.all.length > keeperhub.enabled.length) {
      const disabledPlugins = keeperhub.all.filter(
        (p) => !keeperhub.enabled.includes(p)
      );
      console.log(`   Disabled: ${disabledPlugins.join(", ")}`);
    }
  }

  console.log("Generating plugins/index.ts...");
  generateIndexFile(base.enabled); // Only import enabled base plugins

  console.log("Generating keeperhub/plugins/index.ts...");
  generateKeeperHubIndexFile(keeperhub.enabled); // Only import enabled KeeperHub plugins

  // Register protocols BEFORE importing plugins so that plugins that inject
  // actions into protocol integrations (e.g. safe plugin -> safe protocol)
  // can find the integration in the registry at import time.
  console.log("Registering protocol plugins...");
  const protocolSlugs = await registerProtocolPlugins();
  console.log(`Registered ${protocolSlugs.length} protocol(s)`);

  console.log("Generating keeperhub/protocols/index.ts...");
  generateProtocolsIndexFile();

  console.log("Updating README.md...");
  await updateReadme();

  console.log("\nGenerating lib/types/integration.ts...");
  // Use all plugins for types (both base, keeperhub, and protocol slugs)
  generateTypesFile(base.all, keeperhub.all, protocolSlugs);

  console.log("Generating lib/step-registry.ts...");
  await generateStepRegistry();

  console.log("Generating lib/output-display-configs.ts...");
  await generateOutputDisplayConfigs();

  console.log("\nProcessing step files for codegen templates...");
  await processStepFilesForCodegen();

  console.log("Generating lib/codegen-registry.ts...");
  generateCodegenRegistry();

  console.log("Done! Plugin registry updated.\n");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
