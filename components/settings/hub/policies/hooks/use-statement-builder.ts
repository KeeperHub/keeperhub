"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type CompatibilityFinding,
  checkStatement,
  describeResource,
} from "@/lib/policy/catalog";
import type { SelectorCatalogEntry } from "@/lib/policy/catalog/types";
import type { PolicyDocument } from "@/lib/policy/types";
import {
  buildDocument,
  type CatalogEntryMap,
  catalogKey,
  emptyStatement,
  initialStatements,
  type StatementFormValue,
} from "@/lib/policy/ui";

export type ContractEntries = {
  chainId: number;
  address: string;
  implementationAddress: string | null;
  collisions: string[];
  entries: SelectorCatalogEntry[];
};

export type StatementBuilderState = {
  name: string;
  setName: (next: string) => void;
  description: string;
  setDescription: (next: string) => void;
  statements: StatementFormValue[];
  update: (index: number, next: StatementFormValue) => void;
  add: () => void;
  remove: (index: number) => void;
  /** Records a contract's catalog so capabilities derive from real functions. */
  rememberContract: (contract: ContractEntries) => void;
  document: PolicyDocument;
  findings: CompatibilityFinding[];
};

/**
 * The builder's state and everything derived from it.
 *
 * Lives in a hook so the components below it only render. The document, the
 * findings and the capability derivation are all one function of the form
 * values, and keeping that in a component made them re-derive in three places.
 */
export function useStatementBuilder(input: {
  source: PolicyDocument | null;
  onDocumentChange: (document: PolicyDocument) => void;
}): StatementBuilderState {
  const { source, onDocumentChange } = input;

  const [name, setName] = useState(source?.name ?? "");
  const [description, setDescription] = useState(source?.description ?? "");
  const [statements, setStatements] = useState<StatementFormValue[]>(() =>
    initialStatements(source)
  );
  const [contracts, setContracts] = useState<Record<string, ContractEntries>>(
    {}
  );

  const entries = useMemo<CatalogEntryMap>(() => {
    const map: CatalogEntryMap = {};
    for (const [key, contract] of Object.entries(contracts)) {
      map[key] = contract.entries;
    }
    return map;
  }, [contracts]);

  const document = useMemo(
    () => buildDocument({ name, description, statements, entries }),
    [name, description, statements, entries]
  );

  useEffect(() => {
    onDocumentChange(document);
  }, [document, onDocumentChange]);

  const findings = useMemo<CompatibilityFinding[]>(() => {
    const collected: CompatibilityFinding[] = [];
    for (const statement of document.statements) {
      const resources = (statement.resource ?? []).map((pattern) => {
        const described = describeResource(pattern);
        const contract =
          described.address === null
            ? undefined
            : contracts[catalogKey(described.chainId, described.address)];
        return {
          pattern,
          ...described,
          catalog: contract
            ? {
                chainId: contract.chainId,
                address: contract.address,
                implementationAddress: contract.implementationAddress,
                entries: contract.entries,
                collisions: contract.collisions,
              }
            : null,
        };
      });
      collected.push(...checkStatement(statement, resources));
    }
    return collected;
  }, [document.statements, contracts]);

  const update = useCallback((index: number, next: StatementFormValue) => {
    setStatements((current) =>
      current.map((item, i) => (i === index ? next : item))
    );
  }, []);

  const add = useCallback(() => {
    setStatements((current) => [...current, emptyStatement(current.length)]);
  }, []);

  const remove = useCallback((index: number) => {
    setStatements((current) => current.filter((_, i) => i !== index));
  }, []);

  const rememberContract = useCallback((contract: ContractEntries) => {
    setContracts((current) => {
      const key = catalogKey(contract.chainId, contract.address);
      if (current[key]?.entries === contract.entries) {
        return current;
      }
      return { ...current, [key]: contract };
    });
  }, []);

  return {
    name,
    setName,
    description,
    setDescription,
    statements,
    update,
    add,
    remove,
    rememberContract,
    document,
    findings,
  };
}
