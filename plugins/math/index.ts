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
  ],
};

registerIntegration(mathPlugin);
export default mathPlugin;
