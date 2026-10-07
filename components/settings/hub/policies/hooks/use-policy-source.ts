"use client";

import { useCallback, useMemo, useState } from "react";
import {
  DEFAULT_POLICY_NAME,
  POLICY_SCHEMA_VERSION,
  type PolicyDocument,
  PolicyEnforcementMode,
} from "@/lib/policy";

/**
 * A starting document that is deliberately restrictive and obviously editable.
 *
 * It claims one narrow scope and denies inside it, so pasting it and pressing
 * save cannot accidentally widen anything. An empty document teaches nothing
 * about the shape.
 */
const TEMPLATE: PolicyDocument = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  name: DEFAULT_POLICY_NAME,
  description: "What this policy is for.",
  enforcement: PolicyEnforcementMode.MONITOR,
  manages: ["protocol.lending.**"],
  statements: [
    {
      sid: "no-borrowing",
      effect: "deny",
      capability: ["protocol.lending.borrow"],
    },
    {
      sid: "supply-and-withdraw-under-a-limit",
      effect: "allow",
      capability: ["protocol.lending.supply", "protocol.lending.withdraw"],
      condition: { usdValue: { lte: "25000" } },
      limit: [
        { metric: "usd", window: "1d", max: "100000", scope: "organization" },
      ],
    },
  ],
};

export type PolicySourceState = {
  text: string;
  parseError: string | null;
  edit: (next: string) => void;
  /** Parses and hands the document back, or reports the syntax error. */
  submit: (onValid: (document: PolicyDocument) => void) => void;
};

/**
 * The text view of a policy.
 *
 * Every keystroke that parses is reported upward, so switching back to the
 * builder keeps the work. A half-typed document simply leaves the last good
 * draft standing rather than clearing it.
 */
export function usePolicySource(input: {
  initial: PolicyDocument | null;
  onDraftChange: (document: PolicyDocument) => void;
}): PolicySourceState {
  const { initial, onDraftChange } = input;

  const initialText = useMemo(
    () => JSON.stringify(initial ?? TEMPLATE, null, 2),
    [initial]
  );
  const [text, setText] = useState(initialText);
  const [parseError, setParseError] = useState<string | null>(null);

  const edit = useCallback(
    (next: string) => {
      setText(next);
      try {
        onDraftChange(JSON.parse(next) as PolicyDocument);
        setParseError(null);
      } catch {
        // Not valid yet. The last good draft stands.
      }
    },
    [onDraftChange]
  );

  const submit = useCallback(
    (onValid: (document: PolicyDocument) => void) => {
      let parsed: PolicyDocument;
      try {
        parsed = JSON.parse(text) as PolicyDocument;
      } catch (error) {
        // A JSON syntax error is the author's typo, not a policy problem, so it
        // is reported here rather than sent to the server to come back as one.
        setParseError(
          error instanceof Error ? error.message : "That is not valid JSON"
        );
        return;
      }
      setParseError(null);
      onValid(parsed);
    },
    [text]
  );

  return { text, parseError, edit, submit };
}
