import type {
  ActionConfigField,
  ActionConfigFieldBase,
  IntegrationPlugin,
} from "../registry";
import { registerIntegration } from "../registry-core";
import { PagerDutyIcon } from "./icon";

/**
 * Fields shared by every Events API v2 action. The service picker is the
 * anchor: the workflow stores a service id, and the routing key that actually
 * authorises the event is resolved from it at run time, so no credential ever
 * lands in a workflow definition.
 */
const serviceField: ActionConfigFieldBase = {
  key: "pagerdutyServiceId",
  label: "PagerDuty service",
  type: "pagerduty-service-select",
  required: true,
  helpText:
    "Read from the selected connection's account. The node stores the service id, so renaming the service in PagerDuty changes nothing here.",
};

const retryFields: ActionConfigFieldBase[] = [
  {
    key: "retryAttempts",
    label: "Retry attempts",
    type: "number",
    min: 0,
    max: 5,
    placeholder: "2",
    example: "2",
    helpText:
      "Extra attempts after the first, for connection failures and the statuses worth another try (408, 425, 429, 5xx). A 400 from PagerDuty is a payload problem and is never retried. Every event carries a dedup key, so an event that arrives twice updates one alert instead of paging twice. Default 2, max 5.",
  },
  {
    key: "retryDelay",
    label: "Retry delay (seconds)",
    type: "number",
    min: 0,
    max: 15,
    placeholder: "1",
    example: "1",
    helpText:
      "Linear backoff: attempt N waits this many seconds times N. A rate-limited request waits for the delay PagerDuty reports instead. Default 1, max 15.",
  },
  {
    key: "failOnError",
    label: "Fail the workflow if the page could not be delivered",
    type: "fail-on-error-switch",
    defaultValue: "true",
    helpText:
      "On by default, and it covers every way a page fails to land: a rejection, a timeout, an outage, a deleted service. Turn it off to keep the run going and branch on the node's `status` output instead - it is the one that separates a real page from an event a maintenance window swallowed.",
  },
];

/**
 * The same delivery controls, minus the claim that a repeat is free.
 *
 * PagerDuty offers no dedup key for a change event, so unlike every other
 * action here a retry after a response that was actually delivered leaves two
 * entries on the service timeline. A duplicate deploy marker is cosmetic and a
 * missing one is not, so the retries stay - but the help text has to say which
 * of the two it is buying.
 */
const changeEventRetryFields: ActionConfigFieldBase[] = retryFields.map(
  (field) =>
    field.key === "retryAttempts"
      ? {
          ...field,
          helpText:
            "Extra attempts after the first, for connection failures and the statuses worth another try (408, 425, 429, 5xx). A 400 from PagerDuty is a payload problem and is never retried. A change event carries no dedup key, so one that is delivered but whose response is lost leaves a second entry on the service timeline - a duplicate deploy marker, which is worth the retry because a missing one is not. Default 2, max 5.",
        }
      : field
);

/**
 * A real round trip through the service the node names: open an alert,
 * acknowledge it, resolve it.
 *
 * The connection test proves the credential works. It proves nothing about
 * the service somebody just picked, and a service with no Events API v2
 * integration, one that is disabled, one inside a maintenance window and one
 * wired to the wrong rota all look the same in a dropdown. Without this the
 * first time anybody learns which they have is during an incident.
 */
const testNodeField: ActionConfigFieldBase = {
  key: "pagerdutyTestNode",
  label: "Try it",
  type: "pagerduty-test-node",
};

const dedupKeyField: ActionConfigFieldBase = {
  key: "dedupKey",
  example: "",
  label: "Dedup key",
  type: "template-input",
  placeholder: "Leave blank for one alert per node",
  helpText:
    "PagerDuty groups events that share this key. Blank means one open alert per node, so a check that keeps failing updates that alert instead of paging again. Put a vault or chain id in here to page per subject. PagerDuty's limit is 255 characters and a longer one is shortened - which matters here more than elsewhere, because two keys that differ only after character 255 become one alert.",
};

/**
 * The trigger's key is optional and defaults per node. An acknowledge or a
 * resolve must name the alert it is closing, so this one is required and
 * points at the trigger node's output.
 */
const triggerNodeField: ActionConfigFieldBase = {
  key: "dedupKeyFromNodeId",
  example: "",
  label: "Trigger Incident node this closes",
  type: "pagerduty-trigger-node-select",
  helpText:
    "Its dedup key is reused here, so the two always match. Pick the node rather than referencing its output: on the healthy branch the trigger never ran, so a template reference cannot resolve.",
};

const targetDedupKeyField: ActionConfigFieldBase = {
  key: "dedupKey",
  example: "",
  label: "Dedup key of the alert",
  type: "template-input",
  placeholder: "Leave blank to use the key of the node above",
  helpText:
    "Only needed when the trigger sets its own dedup key: put the same value here. PagerDuty requires a key for acknowledge and resolve, and drops an event whose key matches no open alert - with a 202, so it looks exactly like success. The service must be the same one the trigger used, too.",
};

/**
 * Hold the event back for a moment before sending it.
 *
 * For one ordering that loses the thing the action was for. When two runs of a
 * workflow overlap and the healthy one finishes first, the update can reach
 * PagerDuty before the trigger it was meant to act on. PagerDuty drops an
 * update whose key matches no open alert - answering 202, so nothing complains
 * - and the trigger then opens an alert the update never touched.
 *
 * No node can reorder two runs, and the read-back reports it afterwards, but
 * reporting it is worse than avoiding it. A second or two of delay is enough
 * to lose the race deliberately, and it costs nothing on the common path where
 * there is no race: the alert is already open and a slightly later event
 * applies to it just the same.
 *
 * What it costs when it goes wrong differs by action, so the wording does too.
 * A dropped resolve leaves an incident open. A dropped acknowledge leaves
 * PagerDuty escalating an incident the workflow believes it has taken
 * responsibility for, which is the safer direction but still not what was
 * asked for.
 */
function sendDelayField(
  action: "acknowledge" | "resolve"
): ActionConfigFieldBase {
  const cost =
    action === "resolve"
      ? "leaving an incident nobody closes"
      : "leaving PagerDuty escalating an incident this workflow believes it has taken responsibility for";
  return {
    key: "sendDelaySeconds",
    label: "Wait before sending (seconds)",
    type: "number",
    min: 0,
    max: 5,
    placeholder: "0",
    // Deliberately blank rather than an example. `example` is what seeds the
    // AI's config for this action, and a 2 there would have every generated
    // Resolve hold its event back by two seconds that nobody asked for.
    // Dropping it alone is worse: a number field with neither falls to 10.
    defaultValue: "",
    helpText: `Holds the ${action} back before sending it. For the case where two runs of this workflow overlap and the healthy one finishes first: the ${action} can then reach PagerDuty before the trigger it is acting on, and PagerDuty drops an update matching no open alert - with a 202, so it looks like success - ${cost}. A second or two loses that race on purpose. It costs exactly that much time on every run, so leave it at 0 unless runs of this workflow can overlap. Default 0, max 5.`,
  };
}

function verifyField(defaultValue: "true" | "false"): ActionConfigFieldBase {
  return {
    key: "verifyWithPagerDuty",
    label: "Confirm with PagerDuty afterwards",
    type: "select",
    defaultValue,
    options: [
      { value: "true", label: "Yes, read the incident back" },
      { value: "false", label: "No" },
    ],
    helpText:
      "PagerDuty answers 202 even when nothing matched. On, the node reads the incident back and reports its real status. Needs incidents.read: a read-only API key already has it, but a scoped OAuth app only has what it was granted, and the two scopes the form asks for do not include it. Without it the node still acknowledges or resolves and reports the status as unknown.",
  };
}

const pagerDutyPlugin: IntegrationPlugin = {
  type: "pagerduty",
  egress: "fixed-host",
  label: "PagerDuty",
  description: "Trigger, acknowledge and resolve PagerDuty incidents",

  icon: PagerDutyIcon,

  formFields: [
    {
      id: "apiToken",
      label: "API access key",
      type: "password",
      placeholder: "20-character key from PagerDuty",
      configKey: "apiToken",
      envVar: "PAGERDUTY_API_TOKEN",
      exclusiveGroup: "token",
      exclusiveGroupLabel: "Option A - API token",
      helpText:
        "PagerDuty: Integrations, Developer Tools, API Access Keys, Create New API Key - tick Read-only API Key. Creating one of those needs the Admin or Account Owner role; a personal read-only token from User Settings works too. PagerDuty shows the key once. Read-only covers Trigger, Acknowledge, Resolve and Change Event. Docs: ",
      helpLink: {
        text: "support.pagerduty.com/main/docs/api-access-keys",
        url: "https://support.pagerduty.com/main/docs/api-access-keys",
      },
    },
    {
      id: "oauthClientId",
      label: "OAuth client ID",
      type: "text",
      placeholder: "PDABC12.oauth.pagerduty.com",
      configKey: "oauthClientId",
      envVar: "PAGERDUTY_OAUTH_CLIENT_ID",
      exclusiveGroup: "oauth",
      exclusiveGroupLabel: "Option B - Scoped OAuth",
      helpText:
        "Tighter than an API token, and PagerDuty's own recommendation. Register the app under Integrations, Developer Tools, App Registration, set Functionality to Scoped OAuth. Trigger, Acknowledge, Resolve and Change Event need services.read and escalation_policies.read. Three optional things need one more each: reading an incident back after an acknowledge or resolve needs incidents.read, the priority picker on Create Incident needs priorities.read, and Create Incident itself needs incidents.write. A read-only API token above covers all the reads without any of this.",
    },
    {
      id: "oauthClientSecret",
      label: "OAuth client secret",
      type: "password",
      placeholder: "Shown once when the app is created",
      configKey: "oauthClientSecret",
      envVar: "PAGERDUTY_OAUTH_CLIENT_SECRET",
      exclusiveGroup: "oauth",
      helpText:
        "Exchanged for a short-lived token on demand; KeeperHub stores no token of its own.",
    },
    {
      id: "subdomain",
      label: "Account subdomain",
      type: "text",
      placeholder: "acme",
      configKey: "subdomain",
      envVar: "PAGERDUTY_SUBDOMAIN",
      exclusiveGroup: "oauth",
      helpText:
        "The first label of your PagerDuty address: acme.pagerduty.com means acme. Required for scoped OAuth, ignored when an API token is set. If the account is ever renamed, update this field: the OAuth scope string carries the subdomain, so the old one stops issuing tokens. Nothing else in a node has to change, because services and policies are stored by id.",
    },
    {
      id: "euRegion",
      label: "EU service region",
      type: "checkbox",
      configKey: "euRegion",
      envVar: "PAGERDUTY_EU_REGION",
      defaultValue: false,
      helpText:
        "Tick this if your PagerDuty address contains .eu (acme.eu.pagerduty.com). It switches both hosts to api.eu.pagerduty.com and events.eu.pagerduty.com. Get it wrong and PagerDuty answers 401, which looks like a bad token - Test Connection checks the other region for you and says which way to set it.",
    },
    {
      id: "fromEmail",
      label: "From email (Optional, only for the Create Incident action)",
      type: "text",
      placeholder: "oncall-bot@acme.io",
      configKey: "fromEmail",
      envVar: "PAGERDUTY_FROM_EMAIL",
      helpText:
        "Not a password. PagerDuty attributes the incident it creates to this user, who must exist in the account. Trigger, Acknowledge, Resolve and Change Event never read it.",
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testPagerDuty } = await import("./test");
      return testPagerDuty;
    },
  },

  actions: [
    {
      slug: "trigger-incident",
      label: "Trigger Incident",
      description:
        "Open or update a PagerDuty alert on a service, with a dedup key so repeat runs do not page again",
      category: "PagerDuty",
      stepFunction: "triggerIncidentStep",
      stepImportPath: "trigger-incident",
      docUrl: "https://docs.keeperhub.com/plugins/pagerduty",
      outputFields: [
        {
          field: "delivered",
          description: "Whether PagerDuty accepted the event",
        },
        { field: "dedupKey", description: "Key that identifies the alert" },
        {
          field: "status",
          description:
            "triggered, suppressed when the service took the event and raised no incident, held by the consecutive-runs guard, or failed when the event could not be delivered",
        },
        {
          field: "consecutiveRuns",
          description: "Runs in a row that reached this node",
        },
        {
          field: "requiredRuns",
          description: "Runs in a row configured before paging",
        },
        {
          field: "error",
          description: "Why the event was not delivered, when it was not",
        },
        {
          field: "backupAttempted",
          description: "Whether a backup notification was sent",
        },
        {
          field: "backupDelivered",
          description: "Whether the backup notification landed",
        },
        { field: "backupChannel", description: "discord, slack or telegram" },
        {
          field: "backupError",
          description: "Why the backup notification failed, when it did",
        },
        {
          field: "serviceStatus",
          description: "PagerDuty's service status when the event was sent",
        },
        {
          field: "suppressedByService",
          description:
            "True when the service was in maintenance, so PagerDuty took the event and raised no incident",
        },
        {
          field: "detailsTruncated",
          description: "True when custom details were dropped for size",
        },
        {
          field: "linksDropped",
          description:
            "How many lines of the links field were not an https url, so were not sent",
        },
        {
          field: "fieldsTrimmed",
          description:
            "Which fields were over PagerDuty's limit and were shortened, with their lengths",
        },
        {
          field: "summaryFellBack",
          description:
            "True when the summary template rendered to nothing and the alert went out under a stand-in title",
        },
        { field: "message", description: "PagerDuty's own response message" },
      ],
      configFields: [
        serviceField,
        {
          key: "summary",
          label: "Summary",
          type: "template-input",
          placeholder: "Keeper stalled: {{Check Vault.message}}",
          example: "Keeper stalled on Ethereum",
          required: true,
          helpText:
            "Becomes the alert title. PagerDuty's limit is 1024 characters; anything longer is shortened rather than rejected, because an alert with a cut title still wakes the right person. The Preview below says when a value is over, and the node's `fieldsTrimmed` output says so after a run, since a template can only be measured once it has rendered.",
        },
        {
          key: "severity",
          label: "Severity",
          type: "select",
          defaultValue: "error",
          // Safe to template: `normaliseSeverity` resolves anything it does
          // not recognise to "error", so a value from an upstream step cannot
          // produce an invalid event. Documented in the help text below.
          allowTemplate: true,
          options: [
            { value: "critical", label: "Critical" },
            { value: "error", label: "Error" },
            { value: "warning", label: "Warning" },
            { value: "info", label: "Info" },
          ],
          helpText:
            "How bad the condition is. Accepts a {{template}} from an earlier step; anything that does not resolve to one of these four is sent as error. On a service using dynamic urgency, critical and error page at high urgency while warning and info do not; on other services the urgency rule decides. Priority (P1, P2) cannot be set on an event at all - PagerDuty assigns it from the service's Event Orchestration rules, or use Create Incident to set one directly.",
        },
        {
          key: "source",
          label: "Source",
          type: "template-input",
          placeholder: "The system the event is about",
          helpText:
            "PagerDuty requires a source. Defaults to this node's name. Shortened past 1024 characters, and the node says when it did.",
        },
        dedupKeyField,
        {
          type: "group",
          label: "Details",
          fields: [
            {
              key: "component",
              example: "",
              label: "Component",
              type: "template-input",
              placeholder: "vault-monitor",
              helpText:
                "The part of the source the event is about. Shortened past 1024 characters, and the node says when it did.",
            },
            {
              key: "group",
              example: "",
              label: "Group",
              type: "template-input",
              placeholder: "keeper-bots",
              helpText:
                "A logical grouping of components. Shortened past 1024 characters, and the node says when it did.",
            },
            {
              key: "class",
              example: "",
              label: "Class",
              type: "template-input",
              placeholder: "liquidation",
              helpText:
                "The type of event, used by PagerDuty event rules. Shortened past 1024 characters, and the node says when it did.",
            },
            {
              key: "customDetails",
              example: "",
              label: "Custom details",
              type: "template-textarea",
              rows: 4,
              placeholder: '{ "vault": "{{Check Vault.id}}" }',
              helpText:
                "JSON object shown on the incident. The workflow, run and node ids are added automatically. PagerDuty rejects an event over 512 KB outright, so if the whole event would exceed it these are dropped and replaced by a note rather than losing the page; the node's `detailsTruncated` output says when that happened.",
            },
            {
              key: "links",
              example: "",
              label: "Links",
              type: "template-textarea",
              rows: 3,
              placeholder:
                "Etherscan | https://etherscan.io/tx/{{Check Vault.hash}}",
              helpText:
                "One per line, as text | url, or just a url. The url has to be https. They become clickable links on the incident - an explorer transaction or a dashboard is usually the first thing a responder wants. A line that is not an https url is skipped rather than failing the page; the Preview below shows what will be sent, and the node's linksDropped output counts what was not.",
            },
          ],
        },
        {
          type: "group",
          label: "If the page cannot be delivered",
          fields: [
            {
              key: "backupIntegrationId",
              example: "",
              label: "Backup connection",
              type: "pagerduty-backup-connection-select",
              helpText:
                "When the page cannot be delivered, the same alert and the reason are posted here instead. Only existing Discord, Slack and Telegram connections are offered, so a workflow cannot point this at a new host.",
            },
            {
              key: "backupDestination",
              example: "",
              label: "Backup channel or chat id",
              type: "template-input",
              placeholder: "#alerts, or a Telegram chat id",
              helpText:
                "Slack and Telegram need one; a Discord connection already carries its webhook.",
            },
            {
              key: "treatMaintenanceAsUndelivered",
              label: "Treat a maintenance window as undelivered",
              type: "select",
              defaultValue: "false",
              options: [
                { value: "false", label: "No, report it and carry on" },
                { value: "true", label: "Yes, fire the backup" },
              ],
              helpText:
                "A service in a maintenance window takes the event and raises no incident. Off, the node reports that. On, it is treated like any other undelivered page, so the backup fires.",
            },
          ],
        },
        {
          key: "pagerdutyPreview",
          label: "Preview",
          type: "pagerduty-preview",
        },
        testNodeField,
        // Last and collapsed, the way every other plugin's Advanced group is.
        // What is above it is what somebody has to decide to page at all; what
        // is in it changes when and how hard the node tries, and has a working
        // default for every field.
        {
          type: "group",
          label: "Advanced",
          fields: [
            {
              key: "consecutiveRuns",
              label: "Consecutive runs before paging",
              type: "number",
              min: 1,
              max: 20,
              placeholder: "1",
              // Blank, not 2. This is the field that decides whether the node
              // pages at all on the first failure, and `example` is what the
              // AI's generated config carries - a 2 there means every
              // AI-built PagerDuty node silently sits out the first failure.
              // Blank reads as "leave it", which resolves to 1: page now.
              defaultValue: "",
              helpText:
                "Pages on the Nth run in a row that reaches this node; one run that does not reach it resets the count. On a schedule of every X minutes, N delays the first page by about (N-1) times X - at 3 on an hourly cron that is two hours. Held runs are recorded, not silent. Default 1.",
            },
            ...retryFields,
          ],
        },
      ],
    },
    {
      slug: "acknowledge-incident",
      label: "Acknowledge Incident",
      description:
        "Acknowledge the alert carrying this dedup key. This stops PagerDuty escalating it, so use it only once a human has been told - an automated acknowledge means nobody is paged further",
      category: "PagerDuty",
      stepFunction: "acknowledgeIncidentStep",
      stepImportPath: "acknowledge-incident",
      docUrl: "https://docs.keeperhub.com/plugins/pagerduty",
      outputFields: [
        {
          field: "delivered",
          description: "Whether PagerDuty accepted the event",
        },
        {
          field: "dedupKey",
          description: "Key of the alert that was acknowledged",
        },
        {
          field: "incidentStatus",
          description:
            "Incident status when the check is on: triggered, acknowledged, resolved, or unknown",
        },
        {
          field: "incidentPriority",
          description:
            "The incident's priority when the check is on and it has one",
        },
        {
          field: "incidentUrl",
          description: "Link to the incident, when the check found it",
        },
        {
          field: "error",
          description:
            "Why the event was not delivered, when it was not and the node was told not to fail the run",
        },
        {
          field: "verificationError",
          description:
            "Why the check could not read the incident back, when it could not",
        },
        {
          field: "delayedSeconds",
          description:
            "Seconds this node waited before sending, when it was asked to wait",
        },
        { field: "action", description: "acknowledge or resolve" },
        { field: "message", description: "PagerDuty's own response message" },
      ],
      configFields: [
        serviceField,
        triggerNodeField,
        targetDedupKeyField,
        // On by default here too, for the opposite reason to a resolve: an
        // acknowledge that did not apply leaves PagerDuty escalating an
        // incident the workflow believes it has taken responsibility for, and
        // the 202 says nothing either way.
        verifyField("true"),
        {
          type: "group",
          label: "Delivery",
          fields: [sendDelayField("acknowledge"), ...retryFields],
        },
        testNodeField,
      ],
    },
    {
      slug: "send-change-event",
      label: "Send Change Event",
      description:
        "Record a deploy or configuration change on a service timeline. Never pages anyone",
      category: "PagerDuty",
      stepFunction: "sendChangeEventStep",
      stepImportPath: "send-change-event",
      docUrl: "https://docs.keeperhub.com/plugins/pagerduty",
      outputFields: [
        {
          field: "delivered",
          description: "Whether PagerDuty accepted the change event",
        },
        {
          field: "fieldsTrimmed",
          description:
            "Which fields were over PagerDuty's limit and were shortened, with their lengths",
        },
        {
          field: "error",
          description:
            "Why the change event was not delivered, when it was not and the node was told not to fail the run",
        },
        { field: "message", description: "PagerDuty's own response message" },
      ],
      configFields: [
        serviceField,
        {
          key: "summary",
          label: "Summary",
          type: "template-input",
          placeholder: "Deployed keeper {{Build.version}}",
          required: true,
          helpText: "What changed. Shown on the service's activity timeline.",
        },
        {
          key: "source",
          label: "Source",
          type: "template-input",
          placeholder: "The system that made the change",
        },
        {
          key: "customDetails",
          example: "",
          label: "Custom details",
          type: "template-textarea",
          rows: 3,
          placeholder: '{ "commit": "{{Build.sha}}" }',
        },
        { type: "group", label: "Delivery", fields: changeEventRetryFields },
      ],
    },
    {
      slug: "resolve-incident",
      label: "Resolve Incident",
      description:
        "Close the alert carrying this dedup key. PagerDuty drops it silently when no open alert matches, so this is a no-op rather than an error",
      category: "PagerDuty",
      stepFunction: "resolveIncidentStep",
      stepImportPath: "resolve-incident",
      docUrl: "https://docs.keeperhub.com/plugins/pagerduty",
      outputFields: [
        {
          field: "delivered",
          description: "Whether PagerDuty accepted the event",
        },
        {
          field: "dedupKey",
          description: "Key of the alert that was resolved",
        },
        {
          field: "incidentStatus",
          description:
            "Incident status when the check is on: triggered, acknowledged, resolved, or unknown",
        },
        {
          field: "incidentPriority",
          description:
            "The incident's priority when the check is on and it has one",
        },
        {
          field: "incidentUrl",
          description: "Link to the incident, when the check found it",
        },
        {
          field: "error",
          description:
            "Why the event was not delivered, when it was not and the node was told not to fail the run",
        },
        {
          field: "verificationError",
          description:
            "Why the check could not read the incident back, when it could not",
        },
        {
          field: "delayedSeconds",
          description:
            "Seconds this node waited before sending, when it was asked to wait",
        },
        { field: "action", description: "acknowledge or resolve" },
        { field: "message", description: "PagerDuty's own response message" },
      ],
      configFields: [
        serviceField,
        triggerNodeField,
        targetDedupKeyField,
        // On by default for a resolve: an incident that quietly stays open is
        // the failure this action exists to prevent, and the check is what
        // turns PagerDuty's unconditional 202 into an answer.
        verifyField("true"),
        {
          type: "group",
          label: "Delivery",
          fields: [sendDelayField("resolve"), ...retryFields],
        },
        testNodeField,
      ],
    },
    {
      slug: "create-incident",
      label: "Create Incident (override policy, urgency, priority)",
      description:
        "Create an incident directly, with an escalation policy override and urgency. Needs a write-capable token",
      category: "PagerDuty",
      stepFunction: "createIncidentStep",
      stepImportPath: "create-incident",
      docUrl: "https://docs.keeperhub.com/plugins/pagerduty",
      outputFields: [
        { field: "incidentId", description: "PagerDuty incident id" },
        { field: "incidentNumber", description: "Incident number" },
        { field: "incidentUrl", description: "Link to the incident" },
        {
          field: "status",
          description: "Incident status as PagerDuty created it",
        },
        {
          field: "escalationPolicyFellBack",
          description:
            "True when the chosen policy was gone and the service's own was used",
        },
        {
          field: "delivered",
          description: "Whether PagerDuty created the incident",
        },
        {
          field: "fieldsTrimmed",
          description:
            "Which fields were over PagerDuty's limit and were shortened, with their lengths",
        },
        {
          field: "priorityId",
          description:
            "The priority the incident was created with, when one was chosen",
        },
        {
          field: "error",
          description:
            "Why the incident was not created, when it was not and the node was told not to fail the run",
        },
      ],
      configFields: [
        serviceField,
        {
          key: "title",
          label: "Title",
          type: "template-input",
          placeholder: "Keeper stalled: {{Check Vault.message}}",
          required: true,
          helpText:
            "Shortened past 1024 characters, the same ceiling an alert summary carries, and the node's `fieldsTrimmed` output says when it was.",
        },
        {
          key: "details",
          label: "Details",
          type: "template-textarea",
          rows: 4,
          placeholder: "What happened, and what the responder should check",
        },
        {
          key: "pagerdutyEscalationPolicyId",
          example: "",
          label: "Escalation policy",
          type: "pagerduty-escalation-policy-select",
          helpText:
            "Optional. Leave blank to page the service's own policy, which is what every Events API action does.",
        },
        {
          key: "fallbackToServicePolicy",
          label: "Fall back to the service policy if that one is gone",
          type: "fail-on-error-switch",
          defaultValue: "true",
          helpText:
            "On by default: a policy that has been deleted should not stop the incident, because paging the default rota beats paging nobody. The node's output says when it fell back.",
        },
        {
          key: "urgency",
          label: "Urgency",
          type: "select",
          defaultValue: "service-default",
          // Safe to template: anything that is not "high" or "low" falls
          // through to the service's own urgency rule, which is the default.
          allowTemplate: true,
          options: [
            { value: "service-default", label: "Service default" },
            { value: "high", label: "High" },
            { value: "low", label: "Low" },
          ],
          helpText:
            "High urgency notifies on-call the way the escalation policy says; low urgency does not page. Left at the service default, PagerDuty decides from the service's urgency rule. Accepts a {{template}}; anything that does not resolve to high or low uses the service default.",
        },
        {
          key: "pagerdutyPriorityId",
          example: "",
          label: "Priority",
          type: "pagerduty-priority-select",
          helpText:
            "The account's incident priorities (P1, P2, and so on), read from PagerDuty. A paid-plan feature: an account without it shows nothing here. A scoped OAuth connection also needs priorities.read to list them. Only this REST action can set a priority - an Events API alert takes its priority from the account's Event Orchestration rules instead.",
        },
        {
          key: "incidentKey",
          example: "",
          label: "Incident key",
          type: "template-input",
          placeholder: "Optional",
          helpText:
            "PagerDuty rejects a repeat of an open incident's key rather than merging it, unlike the Events API dedup key. Leave blank unless you are deliberately guarding against a double-create. Shortened past 255 characters.",
        },
        {
          key: "fromEmail",
          example: "",
          label: "From email",
          type: "template-input",
          placeholder: "Falls back to the connection's From email",
          helpText:
            "The PagerDuty user the incident is attributed to. Required by PagerDuty for this call.",
        },
        {
          key: "pagerdutyFromEmailNotice",
          label: "",
          type: "pagerduty-from-email-notice",
        },
        {
          key: "failOnError",
          label: "Fail workflow if PagerDuty rejects the incident",
          type: "fail-on-error-switch",
          defaultValue: "true",
        },
      ],
    },
  ],
};

registerIntegration(pagerDutyPlugin);

export default pagerDutyPlugin;
