import { RPC_SELECTION_CONFIG_KEY } from "@/lib/rpc/engine/scope";
import { RpcSelectionMode } from "@/lib/rpc/engine/types";
import { valueContainsTemplate } from "@/lib/workflow/template-ref";
import type {
  ActionConfigField,
  ActionConfigFieldBase,
  ActionConfigFieldGroup,
} from "@/plugins/registry";

/** The field type that picks which RPC endpoints a node uses. */
export const RPC_SELECTION_FIELD_TYPE = "rpc-config-select";

/** The group every derived RPC selector is placed in. */
export const ADVANCED_GROUP_LABEL = "Advanced";

const CHAIN_SELECT_FIELD_TYPE = "chain-select";

/** How the action and trigger schemas describe the selector's value. */
export const RPC_SELECTION_TYPE_TEXT = `string ("${RpcSelectionMode.AUTO}" | "${RpcSelectionMode.PLATFORM}" | <config id>) - "${RpcSelectionMode.AUTO}" (default) uses the organization's default RPC config for the network, or KeeperHub's endpoints when there is none; "${RpcSelectionMode.PLATFORM}" uses KeeperHub's endpoints; a config id pins one of the organization's RPC configs for the node's network`;

/** What save validation names as the accepted values. */
export const RPC_SELECTION_EXPECTED = `${RpcSelectionMode.AUTO} | ${RpcSelectionMode.PLATFORM} | RPC config id`;

/**
 * A stored selection save accepts: one of the two keywords or a config id.
 * A template is refused, as which endpoints a node uses is not run-time data.
 */
export function isRpcSelectionValue(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !valueContainsTemplate(value)
  );
}

/** The RPC selector for a node whose network is held under `networkKey`. */
export function rpcSelectionField(networkKey: string): ActionConfigFieldBase {
  return {
    key: RPC_SELECTION_CONFIG_KEY,
    label: "RPC endpoint",
    type: RPC_SELECTION_FIELD_TYPE,
    defaultValue: RpcSelectionMode.AUTO,
    networkField: networkKey,
    helpTip: "Which RPC endpoints this node uses on its network.",
  };
}

/** An Advanced group holding only the RPC selector. */
export function rpcSelectionFieldGroup(
  networkKey: string
): ActionConfigFieldGroup {
  return {
    type: "group",
    label: ADVANCED_GROUP_LABEL,
    defaultExpanded: false,
    fields: [rpcSelectionField(networkKey)],
  };
}

function isGroup(field: ActionConfigField): field is ActionConfigFieldGroup {
  return field.type === "group";
}

function chainSelectKey(fields: readonly ActionConfigField[]): string | null {
  for (const field of fields) {
    const inner = isGroup(field) ? field.fields : [field];
    for (const base of inner) {
      if (base.type === CHAIN_SELECT_FIELD_TYPE && base.rpcRouted !== false) {
        return base.key;
      }
    }
  }
  return null;
}

/** True when an action's network picker selects the chain it calls over RPC. */
export function actionUsesRpc(fields: readonly ActionConfigField[]): boolean {
  return chainSelectKey(fields) !== null;
}

function hasRpcSelectionField(fields: readonly ActionConfigField[]): boolean {
  return fields.some((field) =>
    isGroup(field)
      ? field.fields.some((inner) => inner.type === RPC_SELECTION_FIELD_TYPE)
      : field.type === RPC_SELECTION_FIELD_TYPE
  );
}

/**
 * The fields with an RPC selector added when they hold a network picker. The
 * selector goes in the Advanced group, which is created when there is none.
 * Fields that already carry one, or have no network picker, come back as is.
 */
export function withRpcSelectionField(
  fields: ActionConfigField[]
): ActionConfigField[] {
  const networkKey = chainSelectKey(fields);
  if (networkKey === null || hasRpcSelectionField(fields)) {
    return fields;
  }
  const advancedIndex = fields.findIndex(
    (field) => isGroup(field) && field.label === ADVANCED_GROUP_LABEL
  );
  if (advancedIndex === -1) {
    return [...fields, rpcSelectionFieldGroup(networkKey)];
  }
  return fields.map((field, index) =>
    index === advancedIndex && isGroup(field)
      ? { ...field, fields: [...field.fields, rpcSelectionField(networkKey)] }
      : field
  );
}
