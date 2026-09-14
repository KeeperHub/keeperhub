import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { X402Icon } from "./icon";

const x402Plugin: IntegrationPlugin = {
  type: "x402",
  // The resource URL is user-supplied, so paid fetches are plan-gated via
  // the catch-all external-request feature, exactly like webhook.
  egress: "user-destination",
  label: "x402",
  description:
    "Buy data and API calls from pay-per-call x402 endpoints with a spend cap",

  icon: X402Icon,

  // No credentials needed - the URL, spend cap, and payment signature are
  // configured per action. Signing stays at the wallet boundary: the
  // signature comes from a template variable, never from keys held here.
  requiresCredentials: false,

  formFields: [
    {
      id: "info",
      label: "x402 Configuration",
      type: "text",
      placeholder: "No configuration needed",
      configKey: "info",
      helpText:
        "Configure the resource URL, spend cap, and payment signature directly in each x402 action.",
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testX402 } = await import("./test");
      return testX402;
    },
  },

  actions: [
    {
      slug: "fetch-paid-resource",
      label: "Fetch Paid Resource",
      description:
        "Fetch a URL that may require x402 payment: free responses pass through, 402 quotes are spend-cap checked and retried with your X-PAYMENT signature",
      category: "x402",
      stepFunction: "fetchPaidResourceStep",
      stepImportPath: "fetch-paid-resource",
      outputFields: [
        {
          field: "success",
          description: "Whether the resource was fetched successfully",
        },
        {
          field: "paid",
          description: "Whether an x402 payment was made for this fetch",
        },
        {
          field: "statusCode",
          description: "HTTP status code from the response",
        },
        {
          field: "data",
          description: "Response body from the resource endpoint",
        },
        {
          field: "priceUsdc",
          description: "Price paid (or quoted) in USDC, e.g. 0.01",
        },
        {
          field: "paymentRequired",
          description: "True when the endpoint needs payment this node did not make",
        },
        {
          field: "paymentQuote",
          description:
            "Validated payment terms (payTo, asset, network, amountAtomic) for the wallet signing step",
        },
        { field: "error", description: "Error message if failed" },
      ],
      configFields: [
        {
          key: "resourceUrl",
          label: "Resource URL",
          type: "template-input",
          placeholder: "https://api.example.com/yields or {{NodeName.url}}",
          example: "https://api.example.com/yields",
          required: true,
        },
        {
          key: "httpMethod",
          label: "HTTP Method",
          type: "select",
          options: [
            { value: "GET", label: "GET" },
            { value: "POST", label: "POST" },
          ],
          defaultValue: "GET",
          required: true,
        },
        {
          key: "network",
          label: "Network (optional)",
          type: "template-input",
          placeholder: "eip155:8453",
          example: "eip155:8453",
          required: false,
          helpTip:
            "Only honor a 402 quote for this network (CAIP-2 like eip155:8453, chain id like 8453, or name like base). Empty accepts the endpoint's first requirement.",
        },
        {
          key: "maxPriceUsdc",
          label: "Max price (USDC)",
          type: "number",
          placeholder: "0.05",
          defaultValue: "0.05",
          min: 0,
          required: true,
          helpTip:
            "Spend cap per call. Quotes above this fail without paying; the quote is returned for manual handling.",
        },
        {
          key: "paymentSignature",
          label: "Payment signature (optional)",
          type: "template-textarea",
          placeholder: "{{SignPaymentStep.signature}}",
          rows: 3,
          required: false,
          helpTip:
            "Base64 X-PAYMENT value from the org wallet signing step. Empty returns the paymentQuote for signing instead of paying.",
        },
        {
          key: "headers",
          label: "Headers",
          type: "template-textarea",
          placeholder: '{"Content-Type": "application/json"}',
          rows: 4,
          example: '{"Content-Type": "application/json"}',
          required: false,
        },
        {
          key: "requestBody",
          label: "Request body (POST)",
          type: "template-textarea",
          placeholder: '{"key": "value"}',
          rows: 6,
          required: false,
        },
      ],
    },
  ],
};

// Auto-register on import
registerIntegration(x402Plugin);

export default x402Plugin;
