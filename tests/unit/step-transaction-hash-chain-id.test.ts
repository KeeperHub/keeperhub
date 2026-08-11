import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PLUGINS_DIR = join(process.cwd(), "plugins");
const STEP_FILENAME = /\.ts$/;

/**
 * Execution finalize independently re-verifies every claimed transaction
 * hash against the chain before a run may settle as success
 * (reconcileTransactionHashes in lib/workflow/executor/logging.ts). That
 * reconciliation is fail-closed: a hash it cannot attribute to a chain
 * fails the whole batch, so a step that reports `transactionHash` without
 * `chainId` turns its own successful run into a failed one.
 *
 * The tracker reads both fields off the step's success output by name
 * (recordTransactionHashIfPresent), so the contract is a property of the
 * step's result type and can be checked here rather than in the expensive
 * protocol-coverage tier, where the only symptom is a setup workflow
 * failing after every step reported success.
 */

/**
 * Steps whose `transactionHash` is a Solana signature (base58), not an EVM
 * hash. The tracker only records 0x-prefixed hashes, so these outputs never
 * reach reconciliation and have no numeric chain to verify against. Adding
 * an EVM-shaped step to this list would silently reopen the hole.
 */
const NON_EVM_HASH_STEPS = new Set([
  "web3/steps/call-solana-program-core.ts",
  "web3/steps/send-raw-solana-instruction-core.ts",
  "web3/steps/transfer-spl-token-core.ts",
]);

function collectStepFiles(): string[] {
  const found: string[] = [];
  for (const plugin of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!plugin.isDirectory()) {
      continue;
    }
    const stepsDir = join(PLUGINS_DIR, plugin.name, "steps");
    let entries: string[];
    try {
      entries = readdirSync(stepsDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (STEP_FILENAME.test(name)) {
        found.push(join(stepsDir, name));
      }
    }
  }
  return found.sort();
}

function propertyNamed(
  node: ts.TypeLiteralNode,
  name: string
): ts.PropertySignature | undefined {
  for (const member of node.members) {
    if (ts.isPropertySignature(member) && member.name.getText() === name) {
      return member;
    }
  }
  return undefined;
}

function isSuccessBranch(node: ts.TypeLiteralNode): boolean {
  const success = propertyNamed(node, "success");
  const type = success?.type;
  return Boolean(
    type &&
      ts.isLiteralTypeNode(type) &&
      type.literal.kind === ts.SyntaxKind.TrueKeyword
  );
}

/**
 * Every `{ success: true; ... }` object type in the file that also declares
 * `transactionHash`. Nested types are visited too, but a type that does not
 * carry the success discriminant (e.g. query-events' DecodedEvent, whose
 * transactionHash belongs to a log entry rather than to the step output) is
 * not a step result branch and is correctly skipped.
 */
function successBranchesWithHash(source: ts.SourceFile): ts.TypeLiteralNode[] {
  const branches: ts.TypeLiteralNode[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeLiteralNode(node) &&
      isSuccessBranch(node) &&
      propertyNamed(node, "transactionHash")
    ) {
      branches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return branches;
}

function declaresNumericChainId(node: ts.TypeLiteralNode): boolean {
  const chainId = propertyNamed(node, "chainId");
  return chainId?.type?.kind === ts.SyntaxKind.NumberKeyword;
}

const stepFiles = collectStepFiles();

const producers = stepFiles
  .map((path) => {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true
    );
    return {
      relative: path.replace(`${PLUGINS_DIR}/`, ""),
      branches: successBranchesWithHash(source),
    };
  })
  .filter((entry) => entry.branches.length > 0);

describe("step results that report a transaction hash", () => {
  it("finds step files to scan", () => {
    expect(stepFiles.length).toBeGreaterThan(0);
  });

  it("finds the known EVM hash producers", () => {
    const scanned = producers.map((p) => p.relative);
    expect(scanned).toEqual(
      expect.arrayContaining([
        "web3/steps/approve-token-core.ts",
        "web3/steps/write-contract-core.ts",
        "web3/steps/transfer-funds-core.ts",
        "web3/steps/transfer-token-core.ts",
      ])
    );
  });

  it("exempts only steps that are still present", () => {
    const scanned = new Set(producers.map((p) => p.relative));
    for (const exempt of NON_EVM_HASH_STEPS) {
      expect(scanned.has(exempt)).toBe(true);
    }
  });

  for (const { relative, branches } of producers) {
    if (NON_EVM_HASH_STEPS.has(relative)) {
      continue;
    }
    it(`declares a numeric chainId alongside it: ${relative}`, () => {
      for (const branch of branches) {
        expect(
          declaresNumericChainId(branch),
          `${relative} returns transactionHash without "chainId: number"; execution finalize cannot verify the receipt and fails the run`
        ).toBe(true);
      }
    });
  }
});

/**
 * The type-level guard above protects reconciliation itself. This one covers
 * the schema the platform publishes to agents and step authors: an action
 * that advertises `transactionHash` in its outputFields but not `chainId`
 * gives a reader no signal that omitting the chain fails the execution
 * closed, which is exactly how the field came to be missing in the first
 * place.
 */
const NON_EVM_HASH_ACTIONS = new Set([
  "call-solana-program-anchor",
  "send-raw-solana-instruction",
  "transfer-spl-token",
]);

type PublishedAction = {
  slug: string;
  outputFields: string[];
};

function collectPublishedActions(): PublishedAction[] {
  const actions: PublishedAction[] = [];
  for (const plugin of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!plugin.isDirectory()) {
      continue;
    }
    let source: string;
    try {
      source = readFileSync(join(PLUGINS_DIR, plugin.name, "index.ts"), "utf8");
    } catch {
      continue;
    }
    for (const block of source.split(/\n {4}\{\n/).slice(1)) {
      const slug = block.match(/^ {6}slug: "([^"]+)"/m)?.[1];
      const fields = block.match(/outputFields: \[([\s\S]*?)\n {6}\],/)?.[1];
      if (slug && fields) {
        actions.push({
          slug,
          outputFields: [...fields.matchAll(/field: "([^"]+)"/g)].map(
            (m) => m[1] as string
          ),
        });
      }
    }
  }
  return actions;
}

describe("published action schemas that report a transaction hash", () => {
  const published = collectPublishedActions().filter((a) =>
    a.outputFields.includes("transactionHash")
  );

  it("finds the EVM write actions", () => {
    expect(published.length).toBeGreaterThan(0);
  });

  for (const { slug, outputFields } of published) {
    if (NON_EVM_HASH_ACTIONS.has(slug)) {
      continue;
    }
    it(`documents chainId alongside it: ${slug}`, () => {
      expect(
        outputFields.includes("chainId"),
        `action "${slug}" publishes transactionHash without chainId; a step author reading this schema gets no signal that omitting the chain fails the execution closed`
      ).toBe(true);
    });
  }
});
