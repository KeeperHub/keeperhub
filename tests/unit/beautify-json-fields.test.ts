// The Beautify action on a textarea field is opt-in per field, because
// `template-textarea` carries both JSON and prose: a webhook payload and a
// Discord message are the same field type. Marking the wrong one gives the
// user a control that can only ever report a parse error on their message
// body, so these tests pin both directions - what must be marked, and what
// must never be.

import { describe, expect, it } from "vitest";

import { beautifyJson } from "@/lib/utils/beautify";
import {
  type ActionConfigFieldBase,
  flattenConfigFields,
  getAllIntegrations,
} from "@/plugins/registry";

type FoundField = {
  plugin: string;
  actionType: string;
  field: ActionConfigFieldBase;
};

function allConfigFields(): FoundField[] {
  const found: FoundField[] = [];
  for (const plugin of getAllIntegrations()) {
    for (const action of plugin.actions) {
      for (const field of flattenConfigFields(action.configFields ?? [])) {
        found.push({
          plugin: plugin.type,
          actionType: `${plugin.type}/${action.slug}`,
          field,
        });
      }
    }
  }
  return found;
}

/**
 * The exact set of fields carrying the flag, as `<integration>/<action>.<key>`.
 *
 * Pinned as an equality rather than as a denylist of prose keys: a denylist
 * cannot catch the mistake it exists for, because a field added tomorrow is in
 * neither list and passes either way. Any addition or removal fails here, so
 * marking a message body is a decision someone has to write down.
 *
 * Clerk's privateMetadata is marked in source too, but clerk is absent from
 * plugins/plugin-allowlist.json so it never registers.
 */
const EXPECTED_JSON_FIELDS = [
  "data/flatten-findings.sources",
  "pagerduty/send-change-event.customDetails",
  "pagerduty/trigger-incident.customDetails",
  "web3/decode-calldata.abi",
  "webhook/send-webhook.webhookHeaders",
  "webhook/send-webhook.webhookPayload",
];

/**
 * Fields that hold JSON but also accept a lone reference, which the
 * placeholder offers first. A bare `{{ref}}` is already formatted, so the hook
 * has nothing to apply and raises no toast: the button is inert with no
 * feedback, which is worse than not being there. They are named rather than
 * merely absent, so re-marking one has to be an argument someone makes.
 */
const BARE_REFERENCE_FIELDS = [
  "data/extract-fields.source",
  "tempo/batch-payout.payouts",
  // clerk/create-user.publicMetadata and clerk/update-user.publicMetadata are
  // the same shape; clerk never registers, so they cannot be asserted here.
];

describe("valueFormat: json marking", () => {
  it("is only ever set on template-textarea fields", () => {
    const wrong = allConfigFields()
      .filter(({ field }) => field.valueFormat === "json")
      .filter(({ field }) => field.type !== "template-textarea")
      .map(({ actionType, field }) => `${actionType}.${field.key}`);

    expect(wrong).toEqual([]);
  });

  it("covers exactly the fields it is meant to", () => {
    const marked = allConfigFields()
      .filter(({ field }) => field.valueFormat === "json")
      .map(({ actionType, field }) => `${actionType}.${field.key}`)
      .sort();

    expect(marked).toEqual(EXPECTED_JSON_FIELDS);
  });

  it("leaves the fields that also take a bare reference unmarked", () => {
    const marked = new Set(
      allConfigFields()
        .filter(({ field }) => field.valueFormat === "json")
        .map(({ actionType, field }) => `${actionType}.${field.key}`)
    );
    const known = new Set(
      allConfigFields().map(
        ({ actionType, field }) => `${actionType}.${field.key}`
      )
    );

    for (const name of BARE_REFERENCE_FIELDS) {
      // Guards against the field being renamed out from under the list.
      expect(known.has(name)).toBe(true);
      expect(marked.has(name)).toBe(false);
    }
  });

  it("would be a no-op on those fields, which is why they are left out", () => {
    const outcome = beautifyJson("{{@node1:Chainlog.data}}");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toBe("{{@node1:Chainlog.data}}");
    }
  });

  it("leaves every other textarea field unmarked", () => {
    const unmarked = allConfigFields()
      .filter(({ field }) => field.type === "template-textarea")
      .filter(({ field }) => field.valueFormat !== "json")
      .map(({ actionType, field }) => `${actionType}.${field.key}`);

    // Sanity: the prose fields are the majority, so an accidental blanket
    // marking would empty this list.
    expect(unmarked.length).toBeGreaterThan(EXPECTED_JSON_FIELDS.length);
    expect(unmarked).toContain("discord/send-message.discordMessage");
    expect(unmarked).toContain("data/extract-fields.paths");
  });
});

describe("the marked fields' own placeholders format cleanly", () => {
  it("formats a webhook payload with a template in value position", () => {
    const outcome = beautifyJson('{"key": "value", "data": {{Node.field}}}');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toBe(
        '{\n  "key": "value",\n  "data": {{Node.field}}\n}'
      );
    }
  });

  it("formats a tempo payouts array", () => {
    const outcome = beautifyJson(
      '[{"recipient":"0xabc","amount":"100.50","memo":"INV-1042"}]'
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toContain('\n    "recipient": "0xabc"');
    }
  });

  it("formats a flatten-findings sources array holding templates", () => {
    const outcome = beautifyJson(
      '[{"label":"File changed","value":{{File Events.result}}}]'
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toContain('"value": {{File Events.result}}');
    }
  });

  it("formats an ABI that arrived as one line", () => {
    const outcome = beautifyJson(
      '[{"inputs":[],"name":"hat","outputs":[{"name":"","type":"address"}],"stateMutability":"view","type":"function"}]'
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.split("\n").length).toBeGreaterThan(5);
    }
  });
});
