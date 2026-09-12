import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { MathIcon } from "./icon";

const mathPlugin: IntegrationPlugin = {
  type: "math",
  egress: "none",
  label: "Math",
  description:
    "Aggregation and arithmetic operations across array data or multiple upstream node outputs.",
  icon: MathIcon,
  requiresCredentials: false,
  formFields: [],

  testConfig: {
    getTestFunction: async () => {
      const { testMath } = await import("./test");
      return testMath;
    },
  },

  actions: [
    {
      slug: "aggregate",
      label: "Aggregate",
      description:
        "Perform aggregation operations (sum, count, average, median, min, max, product) on numeric values from upstream nodes or arrays, with optional post-aggregation arithmetic.",
      category: "Math",
      stepFunction: "aggregateStep",
      stepImportPath: "aggregate",
      requiresCredentials: false,
      outputFields: [
        { field: "success", description: "Whether the aggregation succeeded" },
        {
          field: "result",
          description:
            "The aggregation result as a string (preserves precision for large integers)",
        },
        {
          field: "resultType",
          description:
            'Whether the result used "number" (standard) or "bigint" (large integer) arithmetic',
        },
        {
          field: "operation",
          description: "The operation(s) performed",
        },
        {
          field: "inputCount",
          description: "Number of values that were aggregated",
        },
        { field: "error", description: "Error message if aggregation failed" },
      ],
      configFields: [
        {
          key: "operation",
          label: "Operation",
          type: "select",
          required: true,
          options: [
            { value: "sum", label: "Sum" },
            { value: "count", label: "Count" },
            { value: "average", label: "Average" },
            { value: "median", label: "Median" },
            { value: "min", label: "Min" },
            { value: "max", label: "Max" },
            { value: "product", label: "Product" },
          ],
          defaultValue: "sum",
          example: "sum",
        },
        {
          key: "inputMode",
          label: "Input Mode",
          type: "select",
          required: true,
          options: [
            {
              value: "explicit",
              label: "Explicit Values",
            },
            {
              value: "array",
              label: "Array from Upstream Node",
            },
          ],
          defaultValue: "explicit",
          example: "explicit",
        },
        {
          key: "explicitValues",
          label: "Values",
          type: "template-textarea",
          placeholder:
            "Comma or newline separated values, e.g.:\n{{@node1:Pool1.balance}}\n{{@node2:Pool2.balance}}\n{{@node3:Pool3.balance}}",
          example: "100, 200, 300",
          rows: 4,
          showWhen: { field: "inputMode", equals: "explicit" },
        },
        {
          key: "arrayInput",
          label: "Array Data",
          type: "template-textarea",
          placeholder: "{{@node1:LoopOutput.results}}",
          example: '[{"balance": "100"}, {"balance": "200"}]',
          rows: 3,
          showWhen: { field: "inputMode", equals: "array" },
        },
        {
          key: "fieldPath",
          label: "Field Path",
          type: "template-input",
          placeholder: "e.g. data or balance.amount",
          helpTip:
            'Property to extract from each array item.\n\n[{balance: "100"}, {balance: "200"}] → balance\n[{token: {amount: 50}}] → token.amount\n[{result: {value: "3"}}] → result.value\n[1, 2, 3] → leave empty',
          showWhen: { field: "inputMode", equals: "array" },
        },
        {
          type: "group",
          label: "Post-Aggregation Arithmetic",
          defaultExpanded: false,
          fields: [
            {
              key: "postOperation",
              label: "Operation",
              type: "select",
              options: [
                { value: "none", label: "None" },
                { value: "add", label: "Add to result" },
                { value: "subtract", label: "Subtract from result" },
                { value: "multiply", label: "Multiply result by" },
                { value: "divide", label: "Divide result by" },
                { value: "modulo", label: "Modulo result by" },
                { value: "power", label: "Raise result to power" },
                { value: "abs", label: "Absolute value" },
                { value: "round", label: "Round to nearest integer" },
                {
                  value: "round-decimals",
                  label: "Round to N decimal places",
                },
                { value: "floor", label: "Round down (floor)" },
                { value: "ceil", label: "Round up (ceil)" },
              ],
              defaultValue: "none",
            },
            {
              key: "postOperand",
              label: "Operand",
              type: "template-input",
              placeholder: "e.g. 24000",
              example: "24000",
              showWhen: {
                field: "postOperation",
                oneOf: [
                  "add",
                  "subtract",
                  "multiply",
                  "divide",
                  "modulo",
                  "power",
                ],
              },
            },
            {
              key: "postDecimalPlaces",
              label: "Decimal Places",
              type: "number",
              placeholder: "e.g. 2",
              example: "2",
              min: 0,
              showWhen: {
                field: "postOperation",
                equals: "round-decimals",
              },
            },
          ],
        },
      ],
    },
    {
      slug: "compare-tolerance",
      label: "Compare With Tolerance",
      description:
        "Compare an actual value against an expected value with a percentage or absolute tolerance. BigInt-safe, so RAD and WAD magnitude values compare without float precision loss.",
      category: "Math",
      stepFunction: "compareToleranceStep",
      stepImportPath: "compare-tolerance",
      requiresCredentials: false,
      outputFields: [
        { field: "success", description: "Whether the comparison ran" },
        {
          field: "withinTolerance",
          description: "True when the difference is inside the tolerance",
        },
        {
          field: "breached",
          description:
            "True when the difference is outside the tolerance - wire this to an alert branch",
        },
        {
          field: "direction",
          description: "above, below or equal, relative to the expected value",
        },
        {
          field: "difference",
          description: "Actual minus expected, as a signed decimal string",
        },
        {
          field: "absoluteDifference",
          description: "The difference without its sign",
        },
        {
          field: "percentDifference",
          description:
            "Signed percentage difference from expected, or null when expected is zero",
        },
        { field: "actual", description: "The normalised actual value" },
        { field: "expected", description: "The normalised expected value" },
        { field: "tolerance", description: "The tolerance that was applied" },
        { field: "mode", description: "percent or absolute" },
        { field: "error", description: "Error message if the comparison failed" },
      ],
      configFields: [
        {
          key: "actual",
          label: "Actual",
          type: "template-input",
          required: true,
          placeholder: "{{@node1:Read Contract.result}}",
          example: "1000000000000000000",
        },
        {
          key: "expected",
          label: "Expected",
          type: "template-input",
          required: true,
          placeholder: "{{@node2:Previous Value.result}}",
          example: "1000000000000000000",
        },
        {
          key: "mode",
          label: "Tolerance Mode",
          type: "select",
          required: true,
          options: [
            { value: "percent", label: "Percentage of expected" },
            { value: "absolute", label: "Absolute difference" },
          ],
          defaultValue: "percent",
        },
        {
          key: "tolerance",
          label: "Tolerance",
          type: "template-input",
          required: true,
          placeholder: "0.5",
          helpTip:
            "In percent mode this is a percentage, so 0.5 means half a percent. In absolute mode it is in the same units as the values.",
          example: "0.5",
        },
        {
          key: "precision",
          label: "Percent Decimal Places",
          type: "number",
          min: 0,
          defaultValue: "6",
          helpTip: "Decimal places used when formatting percentDifference.",
        },
      ],
    },
    {
      slug: "format-number",
      label: "Format Number",
      description:
        "Turn a raw integer or decimal into a readable string - scale down token decimals, group thousands, or shorten to compact K/M/B/T notation with an optional unit.",
      category: "Math",
      stepFunction: "formatNumberStep",
      stepImportPath: "format-number",
      requiresCredentials: false,
      outputFields: [
        { field: "success", description: "Whether formatting succeeded" },
        {
          field: "formatted",
          description: 'The display string, e.g. "1.23M SKY"',
        },
        {
          field: "value",
          description:
            "The full scaled value as a decimal string, with no rounding applied",
        },
        {
          field: "magnitude",
          description: 'The compact suffix used: K, M, B, T or empty',
        },
        { field: "notation", description: "compact or plain" },
        { field: "error", description: "Error message if formatting failed" },
      ],
      configFields: [
        {
          key: "value",
          label: "Value",
          type: "template-input",
          required: true,
          placeholder: "{{@node1:Read Contract.result}}",
          example: "1230000000000000000000000",
        },
        {
          key: "decimals",
          label: "Token Decimals",
          type: "number",
          min: 0,
          defaultValue: "0",
          helpTip:
            "Divides the value by 10 to this power before formatting. Use 18 for a wei amount, 6 for USDC, 0 for a plain number.",
          example: "18",
        },
        {
          key: "notation",
          label: "Notation",
          type: "select",
          options: [
            { value: "compact", label: "Compact (1.23M)" },
            { value: "plain", label: "Plain (1,230,000.00)" },
          ],
          defaultValue: "compact",
        },
        {
          key: "precision",
          label: "Decimal Places",
          type: "number",
          min: 0,
          defaultValue: "2",
        },
        {
          key: "unit",
          label: "Unit",
          type: "template-input",
          placeholder: "SKY",
          helpTip: "Appended after the number, separated by a space.",
          example: "SKY",
        },
      ],
    },
  ],
};

registerIntegration(mathPlugin);
export default mathPlugin;
