/**
 * KeeperHub Extensions
 *
 * Registers KeeperHub-specific field renderers, integration handlers,
 * branding, and component slots using the extension registry system.
 *
 * This file should be imported early in the app lifecycle to ensure
 * extensions are registered before components are rendered.
 */

import { useAtomValue } from "jotai";
import { Info } from "lucide-react";
import { KeeperHubLogo } from "@/components/icons/keeperhub-logo";
import { SendGridConnectionSection } from "@/components/settings/sendgrid-connection-section";
import { Web3WalletSection } from "@/components/settings/web3-wallet-section";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AbiEventArgsField } from "@/components/workflow/config/abi-event-args-field";
import { AbiEventSelectField } from "@/components/workflow/config/abi-event-select-field";
import { AbiWithAutoFetchField } from "@/components/workflow/config/abi-with-auto-fetch-field";
import { ArgsListField } from "@/components/workflow/config/args-list-field";
import { ArrayInputField } from "@/components/workflow/config/array-input-field";
import { CallListField } from "@/components/workflow/config/call-list-field";
import {
  ChainSelectField,
  resolveSelectValue,
} from "@/components/workflow/config/chain-select-field";
import { CodeEditorField } from "@/components/workflow/config/code-editor-field";
import { FailOnErrorSwitchField } from "@/components/workflow/config/fail-on-error-switch-field";
import { GasLimitMultiplierField } from "@/components/workflow/config/gas-limit-multiplier-field";
import { PagerDutyPreviewField } from "@/components/workflow/config/pagerduty-preview-field";
import {
  PagerDutyBackupConnectionField,
  PagerDutyEscalationPolicyField,
  PagerDutyFromEmailNotice,
  PagerDutyPriorityField,
  PagerDutyServiceField,
  PagerDutyTestNodeButton,
  PagerDutyTriggerNodeField,
} from "@/components/workflow/config/pagerduty-resource-field";
import { SponsorGasField } from "@/components/workflow/config/sponsor-gas-field";
import { TokenSelectField } from "@/components/workflow/config/token-select-field";
import { integrationsAtom } from "@/lib/integrations-store";
import {
  registerBranding,
  registerFieldRenderer,
  registerIntegrationFormHandler,
} from "@/lib/workflow/editor/extension-registry";
import { nodesAtom } from "@/lib/workflow/store";

const ARRAY_SUFFIX_RE = /\[\d*\]$/;

// ============================================================================
// Register Custom Field Renderers
// ============================================================================

/**
 * ABI with Auto-Fetch Field
 * Allows users to paste an ABI or auto-fetch it from Etherscan
 */
registerFieldRenderer(
  "abi-with-auto-fetch",
  ({ field, config, onUpdateConfig, disabled }) => {
    const contractAddressField =
      field.contractAddressField || "contractAddress";
    const networkField = field.networkField || "network";
    const value =
      (config[field.key] as string | undefined) || field.defaultValue || "";

    return (
      <div className="space-y-2" key={field.key}>
        <Label className="ml-1" htmlFor={field.key}>
          {field.label}
        </Label>
        <AbiWithAutoFetchField
          config={config}
          contractAddressField={contractAddressField}
          contractInteractionType={field.contractInteractionType}
          disabled={disabled}
          field={field}
          networkField={networkField}
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          onUpdateConfig={onUpdateConfig}
          value={value}
        />
      </div>
    );
  }
);

/**
 * Chain Select Field
 * Dynamic dropdown that fetches enabled chains from /api/chains
 * Respects isEnabled flag from the database
 */
registerFieldRenderer(
  "chain-select",
  ({ field, config, onUpdateConfig, disabled }) => {
    const rawValue =
      (config[field.key] as string | undefined) || field.defaultValue || "";

    // KEEP-137: when showPrivateVariants is active, resolve the display value
    // to include the :private suffix so the select trigger matches the right label.
    const value = field.showPrivateVariants
      ? resolveSelectValue(rawValue, config, true)
      : rawValue;

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <ChainSelectField
          allowedChainIds={field.allowedChainIds}
          chainTypeFilter={field.chainTypeFilter}
          disabled={disabled}
          field={field}
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          onUpdateConfig={
            field.showPrivateVariants ? onUpdateConfig : undefined
          }
          showPrivateVariants={field.showPrivateVariants}
          value={value}
        />
      </div>
    );
  }
);

/**
 * Token Select Field
 * Toggle between supported tokens (stablecoins) and custom token address
 * In supported mode, shows multi-select of system stablecoins
 * In custom mode, shows text input for any ERC20 address
 */
registerFieldRenderer(
  "token-select",
  ({ field, config, onUpdateConfig, disabled }) => {
    const networkField = field.networkField || "network";

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <TokenSelectField
          config={config}
          disabled={disabled}
          field={field}
          networkField={networkField}
          onUpdateConfig={onUpdateConfig}
        />
      </div>
    );
  }
);

/**
 * ABI Event Select Field
 * Dynamic dropdown that parses ABI and shows available events (type === "event")
 */
registerFieldRenderer(
  "abi-event-select",
  ({ field, config, onUpdateConfig, disabled }) => {
    const abiField = field.abiField || "abi";
    const abiValue = (config[abiField] as string | undefined) || "";
    const value =
      (config[field.key] as string | undefined) || field.defaultValue || "";

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <AbiEventSelectField
          abiValue={abiValue}
          disabled={disabled}
          field={field}
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          value={value}
        />
      </div>
    );
  }
);

/**
 * ABI Event Args Field
 * One input per indexed parameter of the selected event, with the ones no
 * topic can match on disabled rather than offered and left to fail at the RPC.
 */
registerFieldRenderer(
  "abi-event-args",
  ({ field, config, onUpdateConfig, disabled }) => {
    const rawAbi = config[field.abiField || "abi"];
    const abiValue = typeof rawAbi === "string" ? rawAbi : "";
    const rawEvent = config[field.abiEventField || "eventName"];
    const eventValue = typeof rawEvent === "string" ? rawEvent : "";
    // Passed through as stored: the step accepts the filter as a JSON string
    // or as an object, and the field reads both.
    const rawValue = config[field.key];
    const value =
      rawValue === undefined || rawValue === null || rawValue === ""
        ? (field.defaultValue ?? "")
        : rawValue;

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <AbiEventArgsField
          abiValue={abiValue}
          disabled={disabled}
          eventValue={eventValue}
          field={field}
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          value={value}
        />
      </div>
    );
  }
);

/**
 * Gas Limit Multiplier Field
 * Number input with dynamic chain default display and helper text
 */
registerFieldRenderer(
  "gas-limit-multiplier",
  ({ field, config, onUpdateConfig, disabled }) => {
    const value =
      (config[field.key] as string | undefined) || field.defaultValue || "";

    return (
      <div className="space-y-2" key={field.key}>
        <Label className="ml-1" htmlFor={field.key}>
          {field.label}
        </Label>
        <GasLimitMultiplierField
          config={config}
          disabled={disabled}
          field={field}
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          value={value}
        />
      </div>
    );
  }
);

/**
 * Code Editor Field
 * Monaco-based JavaScript editor for the Code plugin
 */
registerFieldRenderer(
  "code-editor",
  ({ field, config, onUpdateConfig, disabled }) => {
    const value =
      (config[field.key] as string | undefined) || field.defaultValue || "";

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <CodeEditorField
          disabled={disabled}
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          placeholder={field.placeholder}
          value={value}
        />
      </div>
    );
  }
);

/**
 * JSON Editor Field
 * Monaco-based JSON editor for structured data input
 */
registerFieldRenderer(
  "json-editor",
  ({ field, config, onUpdateConfig, disabled }) => {
    const value =
      (config[field.key] as string | undefined) || field.defaultValue || "";

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <CodeEditorField
          disabled={disabled}
          height="160px"
          language="json"
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          placeholder={field.placeholder}
          value={value}
        />
      </div>
    );
  }
);

/**
 * Call List Builder Field
 * Dynamic list of contract call rows for batch-read-contract mixed mode
 * Each row configures: network, contract address, ABI, function, and arguments
 */
registerFieldRenderer(
  "call-list-builder",
  ({ field, config, onUpdateConfig, disabled }) => {
    const value =
      (config[field.key] as string | undefined) ?? field.defaultValue ?? "";

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <CallListField
          actionConfig={config}
          disabled={disabled}
          field={field}
          onChange={(val: string) => onUpdateConfig(field.key, val)}
          value={value}
        />
      </div>
    );
  }
);

/**
 * Args List Builder Field
 * Dynamic list of argument sets for batch-read-contract uniform mode
 * Each row shows labeled inputs based on the selected function's ABI signature
 */
registerFieldRenderer(
  "args-list-builder",
  ({ field, config, onUpdateConfig, disabled }) => {
    const abiField = field.abiField || "abi";
    const functionField = field.abiFunctionField || "abiFunction";
    const abiValue = (config[abiField] as string | undefined) ?? "";
    const functionValue = (config[functionField] as string | undefined) ?? "";
    const value =
      (config[field.key] as string | undefined) ?? field.defaultValue ?? "";

    return (
      <div className="space-y-2" key={field.key}>
        <Label className="ml-1" htmlFor={field.key}>
          {field.label}
        </Label>
        <ArgsListField
          abiValue={abiValue}
          disabled={disabled}
          field={field}
          functionValue={functionValue}
          onChange={(val: string) => onUpdateConfig(field.key, val)}
          value={value}
        />
      </div>
    );
  }
);

/**
 * Shared label for protocol fields. Shows the field label, required asterisk,
 * and an info tooltip with helpTip text and optional docs link.
 */
function ProtocolFieldLabel({
  field,
}: {
  field: {
    key: string;
    label: string;
    required?: boolean;
    helpTip?: string;
    docUrl?: string;
  };
}): React.ReactNode {
  const hasDocUrl = Boolean(field.docUrl);

  const infoIcon = (
    <Info
      className={`h-3.5 w-3.5 shrink-0 text-muted-foreground ${hasDocUrl ? "cursor-pointer hover:text-primary" : "cursor-help"}`}
    />
  );

  const handleInfoClick = (): void => {
    if (field.docUrl) {
      window.open(field.docUrl, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <Label className="ml-1 flex items-center gap-1.5" htmlFor={field.key}>
      {field.label}
      {field.required && <span className="text-red-500">*</span>}
      {field.helpTip && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="inline-flex"
              onClick={handleInfoClick}
              type="button"
            >
              {infoIcon}
            </button>
          </TooltipTrigger>
          <TooltipContent
            className={`max-w-xs whitespace-pre-line ${hasDocUrl ? "cursor-pointer" : ""}`}
            onClick={handleInfoClick}
            side="top"
          >
            {field.helpTip}
          </TooltipContent>
        </Tooltip>
      )}
    </Label>
  );
}

/**
 * Protocol Address Field
 * Address input with checksum display, validation, and address book support
 */
registerFieldRenderer(
  "protocol-address",
  ({ field, config, onUpdateConfig, disabled }) => {
    const { ProtocolAddressField } =
      require("@/components/workflow/config/protocol-fields/protocol-address-field") as typeof import("@/components/workflow/config/protocol-fields/protocol-address-field");
    const value =
      (config[field.key] as string | undefined) || field.defaultValue || "";

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <ProtocolAddressField
          config={config}
          disabled={disabled}
          fieldKey={field.key}
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          placeholder={field.placeholder}
          value={value}
        />
      </div>
    );
  }
);

/**
 * Protocol Uint Field
 * Numeric text input with non-negative integer validation
 */
registerFieldRenderer(
  "protocol-uint",
  ({ field, config, onUpdateConfig, disabled }) => {
    const { ProtocolUintField } =
      require("@/components/workflow/config/protocol-fields/protocol-uint-field") as typeof import("@/components/workflow/config/protocol-fields/protocol-uint-field");
    const value =
      (config[field.key] as string | undefined) || field.defaultValue || "";
    const solidityType = (field as Record<string, unknown>).solidityType as
      | string
      | undefined;

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <ProtocolUintField
          disabled={disabled}
          fieldKey={field.key}
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          placeholder={field.placeholder}
          solidityType={solidityType}
          value={value}
        />
      </div>
    );
  }
);

/**
 * Protocol Int Field
 * Numeric text input with signed integer validation
 */
registerFieldRenderer(
  "protocol-int",
  ({ field, config, onUpdateConfig, disabled }) => {
    const { ProtocolIntField } =
      require("@/components/workflow/config/protocol-fields/protocol-int-field") as typeof import("@/components/workflow/config/protocol-fields/protocol-int-field");
    const value =
      (config[field.key] as string | undefined) || field.defaultValue || "";
    const solidityType = (field as Record<string, unknown>).solidityType as
      | string
      | undefined;

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <ProtocolIntField
          disabled={disabled}
          fieldKey={field.key}
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          placeholder={field.placeholder}
          solidityType={solidityType}
          value={value}
        />
      </div>
    );
  }
);

/**
 * Protocol ETH Value Field
 * Decimal number input for native ETH value (e.g. "0.1", "1.5")
 */
registerFieldRenderer(
  "protocol-eth-value",
  ({ field, config, onUpdateConfig, disabled }) => {
    const { ProtocolEthValueField } =
      require("@/components/workflow/config/protocol-fields/protocol-eth-value-field") as typeof import("@/components/workflow/config/protocol-fields/protocol-eth-value-field");
    const value =
      (config[field.key] as string | undefined) || field.defaultValue || "";

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <ProtocolEthValueField
          disabled={disabled}
          fieldKey={field.key}
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          placeholder={field.placeholder}
          value={value}
        />
      </div>
    );
  }
);

/**
 * Protocol Bool Field
 * Select dropdown for true/false, switches to text input for template variables
 */
registerFieldRenderer(
  "protocol-bool",
  ({ field, config, onUpdateConfig, disabled }) => {
    const { ProtocolBoolField } =
      require("@/components/workflow/config/protocol-fields/protocol-bool-field") as typeof import("@/components/workflow/config/protocol-fields/protocol-bool-field");
    const value =
      (config[field.key] as string | undefined) || field.defaultValue || "";

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <ProtocolBoolField
          disabled={disabled}
          fieldKey={field.key}
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          value={value}
        />
      </div>
    );
  }
);

/**
 * Protocol Bytes Field
 * Hex text input with 0x-prefix validation
 */
registerFieldRenderer(
  "protocol-bytes",
  ({ field, config, onUpdateConfig, disabled }) => {
    const { ProtocolBytesField } =
      require("@/components/workflow/config/protocol-fields/protocol-bytes-field") as typeof import("@/components/workflow/config/protocol-fields/protocol-bytes-field");
    const value =
      (config[field.key] as string | undefined) || field.defaultValue || "";
    const solidityType = (field as Record<string, unknown>).solidityType as
      | string
      | undefined;

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <ProtocolBytesField
          disabled={disabled}
          fieldKey={field.key}
          onChange={(val: unknown) => onUpdateConfig(field.key, val)}
          placeholder={field.placeholder}
          solidityType={solidityType}
          value={value}
        />
      </div>
    );
  }
);

/** Protocol scalar-array field with one typed editor row per item. */
registerFieldRenderer(
  "protocol-array",
  ({ field, config, onUpdateConfig, disabled }) => {
    const rawValue = config[field.key];
    let value: unknown = rawValue;
    if (typeof rawValue === "string" && rawValue.trim() !== "") {
      try {
        const parsedValue: unknown = JSON.parse(rawValue);
        value = Array.isArray(parsedValue) ? parsedValue : rawValue;
      } catch {
        value = rawValue;
      }
    }

    const itemType =
      field.solidityType?.replace(ARRAY_SUFFIX_RE, "") ?? "value";

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <ArrayInputField
          disabled={disabled}
          fieldKey={field.key}
          itemType={itemType}
          onChange={(val: unknown[]) =>
            onUpdateConfig(field.key, JSON.stringify(val))
          }
          value={value}
        />
      </div>
    );
  }
);

/**
 * Protocol Tuple Array Field
 * Structured array builder for tuple[] inputs (e.g. CCIP tokenAmounts).
 * Delegates to ArrayInputField + TupleInputField for add/remove items with
 * per-component typed fields instead of raw JSON text input.
 */
registerFieldRenderer(
  "protocol-tuple-array",
  ({ field, config, onUpdateConfig, disabled }) => {
    const { ArrayInputField } =
      require("@/components/workflow/config/array-input-field") as typeof import("@/components/workflow/config/array-input-field");

    const rawValue = config[field.key];
    let value: unknown = rawValue;
    if (typeof rawValue === "string" && rawValue.trim() !== "") {
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue;
      }
    }

    const components = field.tupleComponents ?? [];
    const itemType = field.solidityType?.endsWith("[]")
      ? field.solidityType.slice(0, -2)
      : "tuple";

    return (
      <div className="space-y-2" key={field.key}>
        <ProtocolFieldLabel field={field} />
        <ArrayInputField
          components={components}
          disabled={disabled}
          fieldKey={field.key}
          itemType={itemType}
          onChange={(val: unknown[]) =>
            onUpdateConfig(field.key, JSON.stringify(val))
          }
          value={value}
        />
      </div>
    );
  }
);

/**
 * Fail-On-Error Switch Field
 * Write Contract's declarative "Fail workflow on error" toggle. Shares
 * FailOnErrorSwitchField with the HTTP Request node's hardcoded failOnError
 * toggle so both nodes render and resolve it identically. This renderer is
 * specific to that field: it resolves default-on through resolveFailOnError
 * rather than reading field.defaultValue, so it is not a general-purpose
 * boolean switch renderer.
 */
registerFieldRenderer(
  "fail-on-error-switch",
  ({ field, config, onUpdateConfig, disabled }) => (
    <FailOnErrorSwitchField
      description={field.helpTip ?? field.helpText}
      disabled={disabled}
      id={field.key}
      key={field.key}
      label={field.label}
      onChange={(checked) => onUpdateConfig(field.key, checked)}
      value={config[field.key]}
    />
  )
);

/**
 * Gas Sponsorship Switch Field
 * The "Sponsor gas" toggle on a web3 write action. Like the fail-on-error
 * switch it is default-on and resolves through its own helper
 * (resolveSponsorGas) rather than field.defaultValue, so the form and the
 * step can never disagree about what an unset value means.
 */
registerFieldRenderer(
  "gas-sponsorship-switch",
  ({ field, config, onUpdateConfig, disabled }) => (
    <SponsorGasField
      description={field.helpTip ?? field.helpText}
      disabled={disabled}
      id={field.key}
      key={field.key}
      label={field.label}
      onChange={(checked) => onUpdateConfig(field.key, checked)}
      value={config[field.key]}
    />
  )
);

// ============================================================================
// Register Custom Integration Form Handlers
// ============================================================================

/**
 * Web3 Wallet Integration
 * Shows the wallet creation/management UI instead of a standard form
 */
registerIntegrationFormHandler("web3", ({ onSuccess, closeAll }) => (
  <Web3WalletSection
    closeAll={closeAll}
    onSuccess={onSuccess}
    showDelete={false}
  />
));

/**
 * SendGrid Email Integration
 * Shows login requirement for anonymous users to prevent token abuse
 */
registerIntegrationFormHandler("sendgrid", ({ config, updateConfig }) => (
  <SendGridConnectionSection config={config} updateConfig={updateConfig} />
));

// ============================================================================
// Register Branding
// ============================================================================

registerBranding({
  logo: KeeperHubLogo,
  appName: "KeeperHub",
});

// Export a flag to indicate extensions are loaded
export const KEEPERHUB_EXTENSIONS_LOADED = true;

/** Narrow an unknown config value to the string the pickers expect. */
function configString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * PagerDuty pickers and preview.
 *
 * All three read `config.integrationId` - the connection selected on the node
 * - and fetch through the server, so no PagerDuty credential reaches the
 * browser. The node stores ids only; the names shown come from PagerDuty on
 * every load, so a renamed service or policy needs no migration.
 */
registerFieldRenderer(
  "pagerduty-service-select",
  ({ field, config, onUpdateConfig, disabled }) => (
    <div className="space-y-2" key={field.key}>
      <Label className="ml-1" htmlFor={field.key}>
        {field.label}
        {field.required && <span className="ml-0.5 text-red-500">*</span>}
      </Label>
      <PagerDutyServiceField
        disabled={disabled}
        integrationId={configString(config.integrationId) || undefined}
        onChange={(value) => onUpdateConfig(field.key, value)}
        value={configString(config[field.key])}
      />
      {field.helpText && (
        <p className="text-muted-foreground text-xs">{field.helpText}</p>
      )}
    </div>
  )
);

registerFieldRenderer(
  "pagerduty-escalation-policy-select",
  ({ field, config, onUpdateConfig, disabled }) => (
    <div className="space-y-2" key={field.key}>
      <Label className="ml-1" htmlFor={field.key}>
        {field.label}
      </Label>
      <PagerDutyEscalationPolicyField
        disabled={disabled}
        integrationId={configString(config.integrationId) || undefined}
        onChange={(value) => onUpdateConfig(field.key, value)}
        value={configString(config[field.key])}
      />
      {field.helpText && (
        <p className="text-muted-foreground text-xs">{field.helpText}</p>
      )}
    </div>
  )
);

registerFieldRenderer("pagerduty-test-node", ({ field, config, disabled }) => (
  <div className="space-y-2" key={field.key}>
    <Label className="ml-1">{field.label}</Label>
    <PagerDutyTestNodeButton
      disabled={disabled}
      integrationId={configString(config.integrationId) || undefined}
      serviceId={configString(config.pagerdutyServiceId) || undefined}
    />
  </div>
));

registerFieldRenderer("pagerduty-from-email-notice", ({ field, config }) => (
  <PagerDutyFromEmailNotice
    integrationId={configString(config.integrationId) || undefined}
    key={field.key}
    nodeFromEmail={configString(config.fromEmail) || undefined}
  />
));

registerFieldRenderer("pagerduty-preview", ({ field, config, disabled }) => (
  <div className="space-y-2" key={field.key}>
    <Label className="ml-1">{field.label}</Label>
    <PagerDutyPreviewFieldConnected config={config} disabled={disabled} />
  </div>
));

/**
 * The explicit dedup keys every Trigger Incident node on this canvas uses.
 *
 * Two nodes sharing a key share one PagerDuty alert, and a Resolve on either
 * closes it for both. That is occasionally what somebody wants and usually a
 * copy-paste, and it is invisible at run time because PagerDuty merges the
 * events rather than complaining.
 */
function PagerDutyPreviewFieldConnected({
  config,
  disabled,
}: {
  config: Record<string, unknown>;
  disabled?: boolean;
}) {
  // Every Trigger Incident node's explicit key, this one included: the config
  // a field renderer gets carries no node id, so there is nothing to exclude
  // itself by. The preview counts a key as shared once it appears twice.
  const nodes = useAtomValue(nodesAtom);
  const siblingDedupKeys = nodes
    .filter(
      (node) => node.data?.config?.actionType === "pagerduty/trigger-incident"
    )
    .map((node) => configString(node.data?.config?.dedupKey).trim())
    .filter(Boolean);

  return (
    <PagerDutyPreviewField
      config={config}
      disabled={disabled}
      siblingDedupKeys={siblingDedupKeys}
    />
  );
}

registerFieldRenderer(
  "pagerduty-backup-connection-select",
  ({ field, config, onUpdateConfig, disabled }) => (
    <div className="space-y-2" key={field.key}>
      <Label className="ml-1" htmlFor={field.key}>
        {field.label}
      </Label>
      <PagerDutyBackupConnectionFieldConnected
        disabled={disabled}
        onChange={(value) => onUpdateConfig(field.key, value)}
        value={configString(config[field.key])}
      />
      {field.helpText && (
        <p className="text-muted-foreground text-xs">{field.helpText}</p>
      )}
    </div>
  )
);

/** Reads the org's connections from the store the editor already keeps loaded. */
function PagerDutyBackupConnectionFieldConnected({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const connections = useAtomValue(integrationsAtom);
  return (
    <PagerDutyBackupConnectionField
      connections={connections.map((connection) => ({
        id: connection.id,
        name: connection.name,
        type: connection.type,
      }))}
      disabled={disabled}
      onChange={onChange}
      value={value}
    />
  );
}

registerFieldRenderer(
  "pagerduty-priority-select",
  ({ field, config, onUpdateConfig, disabled }) => (
    <div className="space-y-2" key={field.key}>
      <Label className="ml-1" htmlFor={field.key}>
        {field.label}
      </Label>
      <PagerDutyPriorityField
        disabled={disabled}
        integrationId={configString(config.integrationId) || undefined}
        onChange={(value) => onUpdateConfig(field.key, value)}
        value={configString(config[field.key])}
      />
      {field.helpText && (
        <p className="text-muted-foreground text-xs">{field.helpText}</p>
      )}
    </div>
  )
);

registerFieldRenderer(
  "pagerduty-trigger-node-select",
  ({ field, config, onUpdateConfig, disabled }) => (
    <div className="space-y-2" key={field.key}>
      <Label className="ml-1" htmlFor={field.key}>
        {field.label}
      </Label>
      <PagerDutyTriggerNodeFieldConnected
        currentDedupKey={configString(config.dedupKey)}
        currentServiceId={configString(config.pagerdutyServiceId)}
        disabled={disabled}
        onChange={(value) => onUpdateConfig(field.key, value)}
        value={configString(config[field.key])}
      />
      {field.helpText && (
        <p className="text-muted-foreground text-xs">{field.helpText}</p>
      )}
    </div>
  )
);

/**
 * The Trigger Incident nodes on this canvas.
 *
 * Their ids are what the dedup key is derived from, so the acknowledge or
 * resolve closes the alert that trigger opened even on a branch where the
 * trigger node never ran.
 */
function PagerDutyTriggerNodeFieldConnected({
  value,
  disabled,
  currentServiceId,
  currentDedupKey,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  currentServiceId?: string;
  currentDedupKey?: string;
  onChange: (value: string) => void;
}) {
  const nodes = useAtomValue(nodesAtom);
  const triggerNodes = nodes
    .filter(
      (node) => node.data?.config?.actionType === "pagerduty/trigger-incident"
    )
    .map((node) => ({
      id: node.id,
      label: node.data?.label || "Trigger Incident",
      // Carried so the picker can catch a service or dedup key that will not
      // match what that trigger opened.
      serviceId: configString(node.data?.config?.pagerdutyServiceId),
      dedupKey: configString(node.data?.config?.dedupKey),
    }));

  return (
    <PagerDutyTriggerNodeField
      currentDedupKey={currentDedupKey}
      currentServiceId={currentServiceId}
      disabled={disabled}
      nodes={triggerNodes}
      onChange={onChange}
      value={value}
    />
  );
}
