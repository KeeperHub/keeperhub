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
            "The aggregation result as a string (exact on the fixed-point path), or null when divide or modulo had a zero operand and the Zero Divisor field is set to return a null result",
        },
        {
          field: "resultType",
          description:
            '"bigint" when the result is a whole number computed in fixed point, "number" otherwise',
        },
        {
          field: "operation",
          description: "The operation(s) performed",
        },
        {
          field: "inputCount",
          description: "Number of values that were aggregated",
        },
        {
          field: "divisionByZero",
          description:
            "true when the divide or modulo post-operation had a zero operand and the Zero Divisor field is set to return a null result; result is then null and the step succeeds so a Condition can branch on it",
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
            {
              key: "zeroDivisorBehaviour",
              label: "Zero Divisor",
              type: "select",
              options: [
                { value: "fail", label: "Fail the step" },
                {
                  value: "null-result",
                  label: "Return a null result and set divisionByZero",
                },
              ],
              defaultValue: "fail",
              example: "fail",
              helpText:
                "What happens when the operand is zero. Failing stops the run; a null result lets a Condition node branch on divisionByZero.",
              showWhen: {
                field: "postOperation",
                oneOf: ["divide", "modulo"],
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
      slug: "treasury-runway",
      label: "Treasury Runway",
      description:
        "Calculate reserve-adjusted treasury runway, recovery funding and a machine-readable treasury status using precision-safe arithmetic.",
      category: "Math",
      stepFunction: "treasuryRunwayStep",
      stepImportPath: "treasury-runway",
      requiresCredentials: false,
      outputFields: [
        { field: "success", description: "Whether the calculation succeeded" },
        {
          field: "reserveAdjustedBalance",
          description:
            "Treasury balance minus protected reserve, preserved as a signed decimal string",
        },
        {
          field: "reserveBreached",
          description:
            "True when the treasury balance is below the protected reserve",
        },
        {
          field: "netBurnRate",
          description:
            "Outgoing rate minus incoming rate in the selected rate period",
        },
        {
          field: "runwayDays",
          description:
            "Remaining runway in days with up to six decimal places, or null when the treasury is not depleting",
        },
        {
          field: "requiredRecoveryAmount",
          description:
            "Final top-up required to reach minimum runway, rounded upward at the supplied amount precision",
        },
        {
          field: "status",
          description: "Runway status: safe, warning or critical. A safe result can still have reserveBreached set to true.",
        },
        {
          field: "ratePeriod",
          description: "The fixed period used by the incoming and outgoing rates",
        },
        {
          field: "error",
          description: "Error message if the calculation failed",
        },
      ],
      configFields: [
        {
          key: "treasuryBalance",
          label: "Treasury Balance",
          type: "template-input",
          required: true,
          placeholder: "{{@node1:Read Balance.result}}",
          helpTip:
            "Current treasury balance. Use the same amount unit and precision for all balance and rate inputs.",
          example: "530",
        },
        {
          key: "incomingRate",
          label: "Incoming Rate",
          type: "template-input",
          required: true,
          placeholder: "100",
          helpTip: "Amount entering the treasury during each rate period.",
          example: "100",
        },
        {
          key: "outgoingRate",
          label: "Outgoing Rate",
          type: "template-input",
          required: true,
          placeholder: "920",
          helpTip: "Amount leaving the treasury during each rate period.",
          example: "920",
        },
        {
          key: "protectedReserve",
          label: "Protected Reserve",
          type: "template-input",
          required: true,
          placeholder: "0",
          helpTip:
            "Balance reserved from ordinary spending. A balance below this value sets reserveBreached to true.",
          example: "0",
        },
        {
          key: "minimumRunwayDays",
          label: "Minimum Runway Days",
          type: "template-input",
          required: true,
          placeholder: "30",
          helpTip:
            "Required minimum runway in days. Reported runway uses up to six decimal places.",
          example: "30",
        },
        {
          key: "ratePeriod",
          label: "Rate Period",
          type: "select",
          required: true,
          helpTip:
            "Fixed period represented by both incoming and outgoing rates.",
          options: [
            { value: "second", label: "Per second" },
            { value: "minute", label: "Per minute" },
            { value: "hour", label: "Per hour" },
            { value: "day", label: "Per day" },
            { value: "week", label: "Per week (7 days)" },
            { value: "month", label: "Per month (30 days)" },
            { value: "year", label: "Per year (365 days)" },
          ],
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
    {
      slug: "consensus-tolerance",
      label: "Multi-Source Consensus Tolerance",
      description:
        "Evaluate N-way agreement across multiple price feeds or oracle readings (e.g. Chronicle, Chainlink, Pyth). BigInt-safe, checks every pair of sources against the tolerance and reports the median across all sources.",
      category: "Math",
      stepFunction: "consensusToleranceStep",
      stepImportPath: "consensus-tolerance",
      requiresCredentials: false,
      outputFields: [
        { field: "success", description: "Whether the consensus check executed" },
        { field: "inConsensus", description: "True when all sources agree within the specified tolerance" },
        { field: "sourceCount", description: "Number of sources evaluated" },
        { field: "maxDeviation", description: "Largest difference found between any two sources" },
        { field: "maxPercentDeviation", description: "Largest percentage difference between any pair, relative to the larger absolute value of that pair. 0 only when every source agrees exactly" },
        { field: "median", description: "Median across all sources, including any that broke consensus" },
        { field: "values", description: "The source values as they were read, in input order" },
        { field: "tolerance", description: "The tolerance applied" },
        { field: "mode", description: "percent or absolute" },
        { field: "error", description: "Error message if consensus check failed" },
      ],
      configFields: [
        {
          key: "values",
          label: "Source Values",
          type: "template-textarea",
          required: true,
          placeholder: "{{@chronicle:Price.value}}\n{{@chainlink:Price.value}}\n{{@pyth:Price.value}}",
          helpTip: "One value per line, or a JSON array, from multiple oracle/read nodes. Commas inside a value are read as thousands separators, so put each source on its own line.",
          rows: 4,
        },
        {
          key: "tolerance",
          label: "Tolerance",
          type: "template-input",
          required: true,
          placeholder: "1.0",
          helpTip: "In percent mode, 1.0 means 1% max divergence between any pair of sources.",
          example: "1.0",
        },
        {
          key: "mode",
          label: "Tolerance Mode",
          type: "select",
          required: true,
          options: [
            { value: "percent", label: "Percentage deviation" },
            { value: "absolute", label: "Absolute difference" },
          ],
          defaultValue: "percent",
        },
        {
          key: "minSources",
          label: "Minimum Sources Required",
          type: "number",
          min: 2,
          defaultValue: "2",
          helpTip: "Fails if fewer than this number of sources are supplied (prevents single-oracle fallback). Two is the floor, so a lower value is treated as 2.",
        },
        {
          key: "precision",
          label: "Percent Decimal Places",
          type: "number",
          min: 0,
          defaultValue: "6",
        },
      ],
    },
  ],
};

registerIntegration(mathPlugin);
export default mathPlugin;
