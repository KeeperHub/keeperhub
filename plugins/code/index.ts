import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { CodeIcon } from "./icon";

const codePlugin: IntegrationPlugin = {
  type: "code",
  // User code runs `fetch` against any host it chooses - a user-controlled
  // destination. Already paid-gated via the explicit "action.code" feature;
  // classified honestly so nothing downstream treats it as non-egressing.
  egress: "user-destination",
  label: "Code",
  description:
    "Execute custom JavaScript code server-side in a sandboxed VM. Code can make outbound HTTP requests via fetch (subject to the configured timeout). Not a security boundary; intended for authenticated team members only.",

  icon: CodeIcon,

  requiresCredentials: false,

  formFields: [
    {
      id: "info",
      label: "Code Configuration",
      type: "text",
      placeholder: "No configuration needed",
      configKey: "info",
      helpText:
        "Write JavaScript code directly in each Code action. No external configuration required.",
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testCode } = await import("./test");
      return testCode;
    },
  },

  actions: [
    {
      slug: "run-code",
      label: "Run Code",
      description:
        "Execute custom JavaScript in a sandboxed environment with access to workflow data via template variables",
      category: "Code",
      stepFunction: "runCodeStep",
      stepImportPath: "run-code",
      outputFields: [
        {
          field: "success",
          description: "Whether the code executed successfully",
        },
        {
          field: "result",
          description: "The return value of the executed code",
        },
        {
          field: "logs",
          description:
            "Captured console output (log, warn, error) from the code",
        },
        { field: "error", description: "Error message if execution failed" },
        {
          field: "line",
          description: "Line number where the error occurred (if available)",
        },
      ],
      configFields: [
        {
          key: "code",
          label: "JavaScript Code",
          type: "code-editor",
          placeholder: [
            "// Use @ to insert template variables from upstream nodes",
            "// e.g. {{QueryEvents.events}}, {{ReadContract.result}}",
            "",
            "const data = {{QueryEvents.events}};",
            "const filtered = data.filter(item => item.value > 100);",
            "return { count: filtered.length, items: filtered };",
          ].join("\n"),
          required: true,
        },
        {
          type: "group",
          label: "Advanced",
          defaultExpanded: false,
          fields: [
            {
              key: "timeout",
              label: "Timeout (seconds)",
              type: "number",
              placeholder: "60",
              defaultValue: "60",
              min: 1,
              max: 120,
              step: 1,
            },
          ],
        },
      ],
    },
  ],
};

registerIntegration(codePlugin);

export default codePlugin;
