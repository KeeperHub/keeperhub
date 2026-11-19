import type { ShowWhen } from "@/lib/workflow/editor/show-when";
import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { DataIcon } from "./icon";
import { checkFilterConfig, IGNORE_CASE_DEFAULT } from "./filter-config";
import {
  DEFAULT_FILTER_OPERATOR,
  FILTER_OPERATOR_OPTIONS,
  type FilterOperatorRule,
  filterOperatorLabel,
  filterOperatorsWhere,
} from "./filter-operators";

// Shown for the operators whose rule reads this setting. It lists the ones to
// hide, so with no operator stored (the default, equals) the field shows.
function shownWhenOperatorReads(
  reads: (rule: FilterOperatorRule) => boolean
): ShowWhen {
  return {
    all: filterOperatorsWhere((rule) => !reads(rule)).map((operator) => ({
      field: "operator",
      notEquals: operator,
    })),
  };
}

const dataPlugin: IntegrationPlugin = {
  type: "data",
  egress: "none",
  label: "Data",
  description:
    "Reshape workflow data without writing a script: encode and decode strings, convert numbers between decimal and hex, hash a value with keccak256 or SHA-2, pull named fields out of upstream node output, filter an array or pull one field from every item, flatten monitoring results into a findings list, and hold static configuration on the canvas.",
  icon: DataIcon,
  requiresCredentials: false,
  formFields: [],

  testConfig: {
    getTestFunction: async () => {
      const { testData } = await import("./test");
      return testData;
    },
  },

  actions: [
    {
      slug: "encode",
      label: "Encode / Decode",
      description:
        "Convert a string (or a JSON array of strings) to padded hex (bytes8/bytes16/bytes32), raw hex or base64, and back again; or convert a decimal number to hex (minimal or a padded uint word) and back. Replaces hand-written string-to-bytes32 and number-to-hex loops.",
      category: "Data",
      stepFunction: "encodeStep",
      stepImportPath: "encode",
      requiresCredentials: false,
      outputFields: [
        { field: "success", description: "Whether the conversion succeeded" },
        {
          field: "result",
          description:
            "The converted value: a string for a single input, an array for an array input",
        },
        {
          field: "map",
          description:
            "Object keyed by each original value, holding its converted value",
        },
        { field: "count", description: "Number of values converted" },
        {
          field: "operation",
          description: "encode, decode, decimal-to-hex or hex-to-decimal",
        },
        {
          field: "format",
          description:
            "The format used: the text format for encode and decode, the number format (hex, uint256, uint128 or uint64) for decimal-to-hex. Absent for hex-to-decimal, which has no format",
        },
        { field: "error", description: "Error message if the conversion failed" },
      ],
      configFields: [
        {
          key: "operation",
          label: "Operation",
          type: "select",
          required: true,
          options: [
            { value: "encode", label: "Encode (text to hex/base64)" },
            { value: "decode", label: "Decode (hex/base64 to text)" },
            { value: "decimal-to-hex", label: "Decimal to hex (number to hex)" },
            { value: "hex-to-decimal", label: "Hex to decimal (hex to number)" },
          ],
          defaultValue: "encode",
          example: "encode",
        },
        {
          key: "value",
          label: "Value",
          type: "template-textarea",
          required: true,
          rows: 3,
          placeholder:
            'SKY or 255\nor ["SKY", "MKR"] or ["255", "4096"]\nor {{@node1:Label.name}}',
          helpTip:
            'A single value, or a JSON array of values to convert in one step.\n\nEncode / Decode work on text:\nSKY -> 0x534b590000...\n["SKY", "MKR"] -> result is an array, map is keyed by SKY and MKR\n\nDecimal to hex takes a non-negative integer of any size:\n255 -> 0xff\n\nHex to decimal takes hex with or without 0x, padded or not:\n0x00...00ff -> 255',
          example: "SKY",
        },
        {
          key: "format",
          label: "Format",
          type: "select",
          required: true,
          options: [
            { value: "bytes32", label: "bytes32 (32-byte padded hex)" },
            { value: "bytes16", label: "bytes16 (16-byte padded hex)" },
            { value: "bytes8", label: "bytes8 (8-byte padded hex)" },
            { value: "hex", label: "hex (no padding)" },
            { value: "base64", label: "base64" },
          ],
          defaultValue: "bytes32",
          example: "bytes32",
          showWhen: { field: "operation", oneOf: ["encode", "decode"] },
        },
        {
          key: "numberFormat",
          label: "Number format",
          type: "select",
          options: [
            { value: "hex", label: "hex (minimal, 0xff)" },
            { value: "uint256", label: "uint256 (32-byte left-padded word)" },
            { value: "uint128", label: "uint128 (16-byte left-padded word)" },
            { value: "uint64", label: "uint64 (8-byte left-padded word)" },
          ],
          defaultValue: "hex",
          helpTip:
            "How wide the hex output is. A number is always padded on the left, so its value is unchanged.\n\nhex -> 0xff\nuint256 -> 0x00...00ff, the ABI word a contract argument expects\n\nA number too large for the chosen width fails the step rather than truncating.",
          showWhen: { field: "operation", equals: "decimal-to-hex" },
        },
        {
          key: "padding",
          label: "Padding",
          type: "select",
          options: [
            { value: "right", label: "Right (Solidity string to bytesN)" },
            { value: "left", label: "Left (numeric / big-endian)" },
          ],
          defaultValue: "right",
          helpTip:
            "Where the zero bytes go when text is encoded to, or decoded from, a fixed-size format. Solidity pads short strings on the right.\n\nOnly applies to Encode and Decode. Decimal to hex always pads on the left, because zero bytes on the right would multiply the number.",
          showWhen: {
            all: [
              { field: "operation", oneOf: ["encode", "decode"] },
              { field: "format", oneOf: ["bytes32", "bytes16", "bytes8"] },
            ],
          },
        },
      ],
    },
    {
      slug: "extract-fields",
      label: "Extract Fields",
      description:
        "Pick named values out of one or more upstream node outputs by dotted path, returning null instead of failing when a path is missing.",
      category: "Data",
      stepFunction: "extractFieldsStep",
      stepImportPath: "extract-fields",
      requiresCredentials: false,
      outputFields: [
        { field: "success", description: "Whether extraction succeeded" },
        {
          field: "fields",
          description:
            "Object of the extracted values, keyed by the name given to each path (object mode)",
        },
        {
          field: "items",
          description:
            "Array of extracted objects, one per source item (array mode)",
        },
        {
          field: "missing",
          description: "Names whose path was not found in the source",
        },
        { field: "foundCount", description: "Number of paths resolved" },
        { field: "itemCount", description: "Number of source items processed" },
        { field: "error", description: "Error message if extraction failed" },
      ],
      configFields: [
        {
          key: "source",
          label: "Source",
          type: "template-textarea",
          required: true,
          rows: 3,
          placeholder:
            '{{@node1:Chainlog.data}}\nor {"chainlog": {{@node1:Chainlog.data}}, "setup": {{@node2:Setup.result}}}',
          helpTip:
            "A single upstream output, or a JSON object combining several so one node can pull fields from all of them.",
          example: '{"data": {"result": {"vat": "0x35D1"}}}',
        },
        {
          key: "paths",
          label: "Fields",
          type: "template-textarea",
          required: true,
          rows: 5,
          placeholder: "vat = data.result.vat\njug = data.result.jug\nspotter",
          helpTip:
            "One path per line. Use name = path to rename the output, or a bare path to keep its last segment as the name.\n\nvat = data.result.vat -> fields.vat\ndata.result.jug -> fields.jug\nrows.0.amount -> fields.amount",
          example: "vat = data.result.vat",
        },
        {
          key: "mode",
          label: "Mode",
          type: "select",
          options: [
            { value: "object", label: "Single object" },
            { value: "array", label: "Map over an array" },
          ],
          defaultValue: "object",
          helpTip:
            "Map over an array applies the same paths to every item in the source array and returns them in items.",
        },
        {
          key: "onMissing",
          label: "When a path is missing",
          type: "select",
          options: [
            { value: "null", label: "Return null" },
            { value: "empty", label: "Return an empty string" },
            { value: "fail", label: "Fail the step" },
          ],
          defaultValue: "null",
        },
      ],
    },
    {
      slug: "filter",
      label: "Filter Array",
      description:
        "Keep only the items of an array that pass a test, using the Condition operators plus does not contain / start with / end with, and pull one field out of every match into a flat array. Reports the source position (and an optional label) of each match and how many items could not be tested. Choose keep every item to only pull the field.",
      category: "Data",
      stepFunction: "filterStep",
      stepImportPath: "filter",
      requiresCredentials: false,
      validateConfig: checkFilterConfig,
      outputFields: [
        { field: "success", description: "Whether filtering succeeded" },
        { field: "items", description: "The items that passed the test" },
        {
          field: "values",
          description:
            "The Return field of each matching item, as a flat array (null where an item has no such field)",
        },
        {
          field: "indexes",
          description:
            "Source position (from 0) of each matching item, to look up a parallel array",
        },
        {
          field: "labels",
          description:
            "The Labels entry of each matching item (empty when Labels is not set), e.g. the contract names a batch read was given",
        },
        { field: "count", description: "Number of matching items" },
        {
          field: "skippedIndexes",
          description: "Source position of each item the test could not apply to",
        },
        {
          field: "skippedLabels",
          description:
            "The Labels entry of each skipped item (empty when Labels is not set), e.g. the contract whose read failed",
        },
        {
          field: "missingReturn",
          description:
            "Number of matching items that have no Return field; their value is null",
        },
        {
          field: "skipped",
          description:
            "Number of items the test could not apply to, e.g. a missing field or null under a number test",
        },
        { field: "total", description: "Number of items in the source" },
        { field: "error", description: "Error message if filtering failed" },
      ],
      configFields: [
        {
          key: "source",
          label: "Source",
          type: "template-textarea",
          required: true,
          rows: 3,
          placeholder: "{{@node1:Batch Read.results}}",
          helpTip:
            "A JSON array, usually an upstream array field. Up to 10,000 items.",
          example: '[{"success": true, "result": "0x01"}]',
        },
        {
          key: "field",
          label: "Field to test",
          type: "template-input",
          placeholder: "success or meta.name",
          helpText:
            "Leave blank to test each item itself, e.g. an array of names.",
          helpTip: `Dotted path inside each item, e.g. success, meta.name or topics.1 (a number picks a list entry).\n\nAn item without this field can't be tested: it fails the step or, when "If an item can't be tested" is set to Skip, is counted in skipped. The tests that check for a missing value test it as usual: ${filterOperatorsWhere((rule) => rule.test === "presence")
            .map((operator) => filterOperatorLabel(operator))
            .join(", ")}.`,
          example: "success",
          showWhen: shownWhenOperatorReads((rule) => rule.readsField),
        },
        {
          key: "operator",
          label: "Operator",
          type: "select",
          required: true,
          options: [...FILTER_OPERATOR_OPTIONS],
          defaultValue: DEFAULT_FILTER_OPERATOR,
          helpTip:
            "The Condition tests, plus does not contain, does not start with and does not end with.\n\nEach test only looks at items it applies to: number tests at numbers, numeric text and hex; boolean tests at true and false; text tests at text and numbers; array and object tests at lists and objects. By default any other item fails the step; see If an item can't be tested.",
          example: "isTrue",
        },
        {
          key: "value",
          label: "Value",
          type: "template-input",
          required: true,
          placeholder: "e.g. VAULT_, true or 100",
          helpTip:
            'What each item is compared with. Spaces around it are trimmed; quote it to keep them (except under regex).\n\nMatches regex and does not match regex: the regular expression exactly as it should run, e.g. ^VAULT_, without quotes or /.../ around it; no lookahead or back-references. To match a space at either end, write [ ] or \\x20.\nOther text tests and has key: the text as typed, quotes removed.\nNumber tests: a number, e.g. 100, 1.5 or 0x64.\nArray length: a whole number.\nOther tests: 5 is a number, true and false are booleans, null is null, anything else is text. Quote to force text, e.g. "true" matches the text, not the boolean. Quoting a number changes nothing under equals, which compares numbers by value.',
          showWhen: shownWhenOperatorReads((rule) => rule.readsValue),
        },
        {
          key: "ignoreCase",
          label: "Ignore case",
          type: "switch",
          defaultValue: IGNORE_CASE_DEFAULT,
          helpText:
            "Match text whatever its letter case, e.g. a checksummed address against a lowercase one.",
          helpTip:
            "Off by default, also when left blank. Applies to equals, not equals, soft equals, soft not equals, Text: contains, starts with, ends with, matches regex and their does not forms, and Array: contains. From the API or MCP: true or false (a JSON boolean or lowercase text), not a template.",
          showWhen: shownWhenOperatorReads((rule) => rule.readsIgnoreCase),
        },
        {
          key: "returnField",
          label: "Return field",
          type: "template-input",
          placeholder: "result",
          defaultValue: "",
          helpTip:
            "Dotted path pulled from each matching item into values. Leave blank to use Field to test. With Return field blank and either Field to test blank or keep every item, values holds the whole items.\n\nExample: Field to test success, Return field result. values then lists the result of every successful call.",
        },
        {
          key: "missingReturn",
          label: "If a match has no Return field",
          type: "select",
          options: [
            { value: "keep", label: "Keep it, with null in values" },
            { value: "fail", label: "Fail the step" },
          ],
          defaultValue: "keep",
          helpTip:
            "A matching item without the Return field gets null in values and is counted in missingReturn. Fail the step instead when a missing field means the path is wrong, e.g. a typo in Return field.",
        },
        {
          key: "labels",
          label: "Labels",
          type: "template-textarea",
          rows: 2,
          // Blank, so the AI prompt example does not seed placeholder text.
          defaultValue: "",
          placeholder:
            '{{@node1:Contract names.result}} or ["VAULT_A", "VAULT_B"]',
          helpText:
            "Optional. A list as long as Source, so an alert can name what matched.",
          helpTip:
            "A JSON array with one entry per Source item, in the same order, e.g. the names of the contracts a batch read was given. The entries at the matching positions come out in labels, and those of skipped items in skippedLabels.\n\nIt must have exactly as many entries as Source, or the step fails.",
        },
        {
          key: "untestable",
          label: "If an item can't be tested",
          type: "select",
          options: [
            { value: "fail", label: "Fail the step" },
            { value: "skip", label: "Skip it and count it in skipped" },
          ],
          defaultValue: "fail",
          helpTip:
            "An item can't be tested when the field is missing, or its value is the wrong kind for the test: null under a number or boolean test, an object under a text test. A reverted batch read has result null, so it counts here.\n\nFail the step is the default, so a read an attacker can make revert cannot pass quietly. Skip keeps the run going: branch on skipped > 0 to alert on it, and use skippedLabels to name the items.",
          showWhen: shownWhenOperatorReads((rule) => rule.canSkip),
        },
      ],
    },
    {
      slug: "flatten-findings",
      label: "Flatten Findings",
      description:
        "Flatten several monitoring results into one findings list with per-source labels and severities, plus a ready-to-alert count and summary.",
      category: "Data",
      stepFunction: "flattenFindingsStep",
      stepImportPath: "flatten-findings",
      requiresCredentials: false,
      outputFields: [
        { field: "success", description: "Whether the scan succeeded" },
        {
          field: "anyFound",
          description: "True when at least one source produced a finding",
        },
        { field: "count", description: "Total number of findings" },
        {
          field: "findings",
          description:
            "Array of { label, severity, hash, item } - one entry per finding",
        },
        {
          field: "labels",
          description: "Labels of the sources that produced findings",
        },
        {
          field: "firstHash",
          description:
            "The first transaction hash found across all findings, or null",
        },
        {
          field: "summary",
          description: "Human-readable per-label summary for an alert body",
        },
        {
          field: "truncated",
          description: "True when findings was capped by Max Findings",
        },
        { field: "error", description: "Error message if the scan failed" },
      ],
      configFields: [
        {
          key: "sources",
          label: "Sources",
          type: "template-textarea",
          valueFormat: "json",
          required: true,
          rows: 8,
          placeholder:
            '[\n  {"label": "File changed", "value": {{@node1:File Events.result}}},\n  {"label": "Owner call", "value": {{@node2:Owner Txs.result}}, "severity": "critical"}\n]',
          helpTip:
            'JSON array of sources. Each entry needs a label and a value.\n\nvalue accepts: an object with events / transactions / logs / rows / items / results (each element becomes a finding), an array (each element becomes a finding), a boolean (true is one finding), or any other object (one finding).\n\nOptional per-entry keys: severity, and itemsPath to point at a nested array.',
          example:
            '[{"label": "File changed", "value": {"events": [{"transactionHash": "0xabc"}]}}]',
        },
        {
          key: "defaultSeverity",
          label: "Default Severity",
          type: "template-input",
          placeholder: "warning",
          defaultValue: "warning",
          helpTip:
            "Used for any source that does not carry its own severity key.",
        },
        {
          key: "hashField",
          label: "Hash Field",
          type: "template-input",
          placeholder: "transactionHash",
          defaultValue: "transactionHash",
          helpTip:
            "Dotted path inside each finding to read a transaction hash from, used for firstHash.",
        },
        {
          key: "maxFindings",
          label: "Max Findings",
          type: "number",
          min: 1,
          defaultValue: "100",
          helpTip:
            "Cap on the findings array so a runaway source cannot blow up the alert payload. count still reports the true total.",
        },
      ],
    },
    {
      slug: "hash",
      label: "Hash",
      description:
        "Hash a value (or a JSON array of values) with keccak256, SHA-2, SHA3-256, RIPEMD-160 or BLAKE2b. One-way, unlike Encode / Decode. Optionally truncate and right-pad the digest to produce a function selector or an event topic.",
      category: "Data",
      stepFunction: "hashStep",
      stepImportPath: "hash",
      requiresCredentials: false,
      outputFields: [
        { field: "success", description: "Whether hashing succeeded" },
        {
          field: "result",
          description:
            "The digest: a string for a single input, an array for an array input",
        },
        {
          field: "map",
          description: "Object keyed by each original value, holding its digest",
        },
        { field: "count", description: "Number of values hashed" },
        { field: "algorithm", description: "The algorithm used" },
        {
          field: "digestBytes",
          description:
            "Width of each digest in bytes, after any truncation and padding",
        },
        { field: "error", description: "Error message if hashing failed" },
      ],
      configFields: [
        {
          key: "algorithm",
          label: "Algorithm",
          type: "select",
          required: true,
          // Ordered alphabetically by label, case-insensitive, plain code-unit
          // comparison. "SHA-256" and "SHA-512" sort before "SHA3-256" because
          // "-" (0x2D) precedes "3" (0x33). tests/unit/data-hash-definition.test.ts
          // asserts this ordering so it cannot drift as algorithms are added.
          //
          // keccak256 is no longer first, but remains the default: the form opens
          // on it regardless of where it sits in the list.
          options: [
            { value: "blake2b-256", label: "BLAKE2b-256" },
            { value: "keccak256", label: "keccak256 (Ethereum)" },
            { value: "ripemd160", label: "RIPEMD-160" },
            { value: "sha256", label: "SHA-256" },
            { value: "sha512", label: "SHA-512" },
            { value: "sha3-256", label: "SHA3-256 (NIST - not Ethereum)" },
          ],
          defaultValue: "keccak256",
          helpTip:
            "keccak256 is the hash the EVM uses: function selectors and event topics, including the topic that carries an indexed string or bytes argument.\n\nSHA3-256 is NOT the same thing. Ethereum adopted Keccak before NIST changed the padding, so the two give completely different results for the same input. Pick SHA3-256 only if a non-EVM protocol asked for it by that name.",
          example: "keccak256",
        },
        {
          key: "value",
          label: "Value",
          type: "template-textarea",
          required: true,
          rows: 3,
          placeholder:
            'frob(bytes32,address,address,address,int256,int256)\nor ["Transfer(address,address,uint256)", "Approval(address,address,uint256)"]\nor {{@node1:Label.result}}',
          helpTip:
            "A single value, or a JSON array of values to hash in one step.\n\nFor an array, result is an array and map is keyed by each original value.\n\nA single value is trimmed, so a stray trailing newline cannot change the digest. Array elements are not, so [\"  a  \"] hashes the spaces too.\n\nAn empty value is hashed rather than refused: keccak256 of nothing is c5d24601... , the EXTCODEHASH of an account with no code.",
          example: "frob(bytes32,address,address,address,int256,int256)",
        },
        {
          key: "inputEncoding",
          label: "Input encoding",
          type: "select",
          required: true,
          options: [
            { value: "utf8", label: "Text (hash the characters)" },
            { value: "hex", label: "Hex bytes (hash the bytes)" },
            { value: "base64", label: "Base64 (decode, then hash the bytes)" },
          ],
          defaultValue: "utf8",
          helpTip:
            "How the value is read before hashing, and the easiest thing to get wrong.\n\nGiven 0x1234, Text hashes the six characters 0 x 1 2 3 4, while Hex bytes hashes the two bytes 0x12 0x34. Both succeed and give different answers.\n\nFunction and event signatures are Text. A raw byte payload from an upstream node is Hex bytes. Base64 is for a payload that arrived encoded - a webhook body, a signed blob - where decoding it to text first would corrupt any byte that is not valid UTF-8.\n\nBase64 accepts either alphabet, standard or URL-safe, with or without padding, but not a mixture of the two.",
          example: "utf8",
        },
        // Both widths carry `defaultValue: ""` and deliberately no `example`.
        //
        // generateAIActionPrompts reads example, then defaultValue, then a type
        // default of 10, and the JSON it builds is the canonical config for this
        // action in the workflow-generation prompt. An example of 4 and 32 there
        // seeds every generated Hash node to truncate to a selector, so "sha256
        // the webhook body" would return a 4-byte value and raise nothing. A
        // blank default emits "outputBytes":"" instead, which reads as "leave
        // blank" and matches the helpTip. The form is unaffected: it already
        // opens blank.
        {
          key: "outputBytes",
          label: "Output bytes",
          type: "number",
          min: 1,
          placeholder: "32",
          defaultValue: "",
          helpTip:
            "Keep only the first N bytes of the digest. Leave blank for the full digest.\n\nSet 4 to turn a function signature into its selector:\nfrob(bytes32,address,address,address,int256,int256) -> 0x76088703\n\nA truncated digest is not the shorter standard hash of the same family. SHA-512 cut to 32 bytes is not SHA-512/256, and BLAKE2b-256 is not BLAKE2b-512 cut down: both mix the output length into their initial state. Truncate for a selector, not to derive a shorter named hash.",
        },
        {
          key: "padTo",
          label: "Pad to",
          type: "number",
          min: 1,
          placeholder: "32",
          defaultValue: "",
          helpTip:
            "Right-pad the result with zero bytes to this width. Leave blank for no padding.\n\nWith Output bytes 4 and Pad to 32 you get the 32-byte topic that filters an anonymous LogNote event:\n0x7608870300000000000000000000000000000000000000000000000000000000\n\nPadding is on the right because that is where the EVM puts it - the selector sits left-aligned in the topic word.",
        },
        {
          key: "outputFormat",
          label: "Output format",
          type: "select",
          options: [
            { value: "hex", label: "hex (0x-prefixed)" },
            { value: "base64", label: "base64" },
            { value: "base64url", label: "base64url (URL-safe, unpadded)" },
          ],
          defaultValue: "hex",
          helpTip:
            "hex is what every on-chain use wants: a topic or a bytes32 argument.\n\nbase64url swaps + and / for - and _ and drops the padding, so the digest can go into a URL, a filename or a header without further escaping.\n\nFor a digest as a decimal number, feed hex into Encode / Decode with Hex to decimal, which stays exact above 2^53.",
        },
      ],
    },
    {
      slug: "static-config",
      label: "Static Config",
      description:
        "Hold static JSON configuration on the canvas - address lists, constants, wallet registries - without wrapping it in a script.",
      category: "Data",
      stepFunction: "staticConfigStep",
      stepImportPath: "static-config",
      requiresCredentials: false,
      outputFields: [
        { field: "success", description: "Whether the JSON parsed" },
        { field: "result", description: "The configuration value" },
        { field: "keys", description: "Top-level keys when the value is an object" },
        {
          field: "count",
          description: "Number of keys for an object, or entries for an array",
        },
        {
          field: "valueType",
          description: "object, array or primitive",
        },
        { field: "error", description: "Error message if the JSON is invalid" },
      ],
      configFields: [
        {
          key: "value",
          label: "Value",
          type: "json-editor",
          required: true,
          placeholder:
            '{\n  "vat": "0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B",\n  "jug": "0x19c0976f590D67707E62397C87829d896Dc0f1F1"\n}',
          helpTip:
            "Any JSON value. Downstream nodes read it with {{@this-node:Label.result}} and can index into it, e.g. result.vat.",
          example: '{"vat": "0x35D1"}',
        },
      ],
    },
  ],
};

registerIntegration(dataPlugin);
export default dataPlugin;
