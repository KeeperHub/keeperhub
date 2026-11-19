/**
 * Logic for data/compare-arrays. No "use step": compare-arrays.ts wraps it and
 * tests call it directly. A pure comparison; it reads and writes no state.
 *
 * Without a key field items are matched by value. With one they are matched by
 * the value at that path, and an item whose key is on both sides but whose
 * content differs is changed. Within one side the first item with a key (or
 * value) wins; later repeats are ignored.
 */

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { getErrorMessage } from "@/lib/utils";
import { valueContainsTemplate } from "@/lib/workflow/template-ref";
import {
  isBlank,
  MAX_FILTER_ITEMS,
  parseArrayInput,
  readPath,
} from "../filter-config";
import { isPlainObject, resolveSegments, splitPath } from "./resolve-path-core";

const EN_US = "en-US";
const NULL_TEXT = "null";

export type CompareArraysCoreInput = {
  previous?: unknown;
  current: unknown;
  keyField?: unknown;
};

type CompareArraysOutput = {
  success: true;
  added: unknown[];
  removed: unknown[];
  changed: unknown[];
  previousChanged: unknown[];
  unchanged: unknown[];
  merged: unknown[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
  hasChanges: boolean;
};

export type CompareArraysResult =
  | CompareArraysOutput
  | { success: false; error: string; errorClass?: ExecutionErrorType };

type Entry = { key: string; item: unknown; content: string };

// JSON text with object keys sorted, so key order never makes two items differ.
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const parts = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? NULL_TEXT;
}

function readArray(raw: unknown, name: string, blankIsEmpty: boolean): unknown[] {
  if (blankIsEmpty && (isBlank(raw) || String(raw).trim() === NULL_TEXT)) {
    return [];
  }
  const items = parseArrayInput(raw, name);
  if (items.length > MAX_FILTER_ITEMS) {
    throw new Error(
      `${name} has ${items.length.toLocaleString(EN_US)} items; the limit is ${MAX_FILTER_ITEMS.toLocaleString(EN_US)}.`
    );
  }
  return items;
}

// Items by identity, first occurrence winning, in source order.
function toEntries(
  items: unknown[],
  segments: string[],
  name: string
): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const [index, item] of items.entries()) {
    const content = canonical(item);
    let key = content;
    if (segments.length > 0) {
      const keyValue = resolveSegments(item, segments);
      if (keyValue === undefined || keyValue === null) {
        throw new Error(
          `${name} item ${index + 1} has no value at Key field "${segments.join(".")}".`
        );
      }
      key = canonical(keyValue);
    }
    if (!entries.has(key)) {
      entries.set(key, { key, item, content });
    }
  }
  return entries;
}

function runCompare(input: CompareArraysCoreInput): CompareArraysOutput {
  const segments = splitPath(readPath(input.keyField, "Key field"));
  const previous = toEntries(
    readArray(input.previous, "Previous", true),
    segments,
    "Previous"
  );
  const current = toEntries(
    readArray(input.current, "Current", false),
    segments,
    "Current"
  );
  const output: CompareArraysOutput = {
    success: true,
    added: [],
    removed: [],
    changed: [],
    previousChanged: [],
    unchanged: [],
    merged: [],
    addedCount: 0,
    removedCount: 0,
    changedCount: 0,
    hasChanges: false,
  };

  for (const entry of current.values()) {
    const before = previous.get(entry.key);
    if (!before) {
      output.added.push(entry.item);
    } else if (before.content === entry.content) {
      output.unchanged.push(entry.item);
    } else {
      output.changed.push(entry.item);
      output.previousChanged.push(before.item);
    }
  }
  for (const entry of previous.values()) {
    const now = current.get(entry.key);
    if (!now) {
      output.removed.push(entry.item);
    }
    output.merged.push(now ? now.item : entry.item);
  }
  output.merged.push(...output.added);
  output.addedCount = output.added.length;
  output.removedCount = output.removed.length;
  output.changedCount = output.changed.length;
  output.hasChanges =
    output.addedCount + output.removedCount + output.changedCount > 0;
  return output;
}

export function compareArrays(
  input: CompareArraysCoreInput
): CompareArraysResult {
  try {
    return runCompare(input);
  } catch (error) {
    return {
      success: false,
      error: `Compare Arrays failed: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.USER,
    };
  }
}

/** The save-time check: the step's own parsing on the settings typed so far. */
export function checkCompareArraysConfig(
  config: Record<string, unknown>
): { field: string; message: string } | undefined {
  const typed = (key: string): unknown =>
    valueContainsTemplate(config[key]) ? undefined : config[key];
  const checks: [string, () => void][] = [
    ["keyField", () => readPath(typed("keyField"), "Key field")],
    [
      "previous",
      () => {
        const value = typed("previous");
        if (value !== undefined) {
          readArray(value, "Previous", true);
        }
      },
    ],
    [
      "current",
      () => {
        const value = typed("current");
        if (value !== undefined && !isBlank(value)) {
          readArray(value, "Current", false);
        }
      },
    ],
  ];
  for (const [field, check] of checks) {
    try {
      check();
    } catch (error) {
      return { field, message: getErrorMessage(error) };
    }
  }
  return;
}
