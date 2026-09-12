import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { DataIcon } from "./icon";

const dataPlugin: IntegrationPlugin = {
  type: "data",
  egress: "none",
  label: "Data",
  description:
    "Reshape workflow data without writing a script: encode and decode strings, pull named fields out of upstream node output, flatten monitoring results into a findings list, and hold static configuration on the canvas.",
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
        "Convert a string (or a JSON array of strings) to padded hex (bytes8/bytes16/bytes32), raw hex or base64, and back again. Replaces hand-written string-to-bytes32 loops.",
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
        { field: "operation", description: "encode or decode" },
        { field: "format", description: "The format used" },
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
          placeholder: 'SKY\nor ["SKY", "MKR"]\nor {{@node1:Label.name}}',
          helpTip:
            'A single value, or a JSON array of values to convert in one step.\n\nSKY -> 0x534b590000...\n["SKY", "MKR"] -> result is an array, map is keyed by SKY and MKR',
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
            "Where the zero bytes go in a fixed-size format. Solidity pads short strings on the right.",
          showWhen: { field: "format", oneOf: ["bytes32", "bytes16", "bytes8"] },
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
