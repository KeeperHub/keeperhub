/**
 * What a collapsed config group should say about itself.
 *
 * A group collapses to one line, so the values inside it are out of sight and
 * stay that way - somebody reopening a node sees "Delivery" and cannot tell
 * whether it holds a carefully tuned backup channel or nothing at all. The
 * usual outcome is opening every group in turn to find out, and the worse one
 * is not opening them and missing a setting that is doing something.
 *
 * "Filled in" here means somebody chose it, not merely that the field has a
 * value: a group whose fields all sit at their defaults is the same group as
 * an untouched one, and counting those would put a badge on every group on
 * every node and say nothing.
 *
 * An `example` that is identical to the field's `placeholder` counts as a
 * default too, because `generateAIActionPrompts` seeds `example` into every
 * generated node and a plugin writing the same string in both is saying that
 * value is what the step applies anyway. An example that differs from the
 * placeholder is a sample, not a default, and still counts as chosen.
 */

import { evaluateShowWhen } from "@/lib/workflow/editor/show-when";
import {
  type ActionConfigFieldBase,
  isDisplayOnlyField,
} from "@/plugins/registry";

/** The stored value, as the form would have written it. */
function storedValue(config: Record<string, unknown>, key: string): unknown {
  return config[key];
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

/**
 * Whether this field carries a choice somebody made.
 *
 * A value equal to the field's own `defaultValue` does not, and the
 * comparison is done as strings because a select writes "true" where a
 * default may be declared as `true` - the form stores what the control
 * produced, not what the plugin declared.
 */
export function fieldIsSet(
  field: ActionConfigFieldBase,
  config: Record<string, unknown>
): boolean {
  if (isDisplayOnlyField(field.type)) {
    return false;
  }
  // A field the form is not showing is not something somebody filled in, even
  // when a stored value survives from before its condition stopped holding.
  // `hidden` is checked for the same reason `showWhen` is - `renderField`
  // honours both - so that a group holding one cannot badge permanently with
  // a label nobody can see.
  if (field.hidden || !evaluateShowWhen(field.showWhen, config)) {
    return false;
  }
  const value = storedValue(config, field.key);
  if (isEmpty(value)) {
    return false;
  }
  if (field.defaultValue !== undefined) {
    return String(value) !== String(field.defaultValue);
  }
  // A field can document its effective default without declaring one: the step
  // applies it, and the form shows it as the placeholder. When `example`
  // matches that placeholder exactly, the plugin is saying "this is what you
  // get anyway", and `generateAIActionPrompts` seeds it into every generated
  // node - so a value equal to it cannot be told apart from one nobody chose.
  //
  // The equality matters. math/aggregate declares `example: "2"` against
  // `placeholder: "e.g. 2"`, where blank and 2 are genuinely different at run
  // time; treating that example as a default hid a real setting.
  if (
    field.example !== undefined &&
    field.placeholder !== undefined &&
    field.example === field.placeholder
  ) {
    return String(value) !== String(field.example);
  }
  return true;
}

/**
 * How many fields in this group somebody has set, and their labels.
 *
 * The labels are for the collapsed group's tooltip: a count answers "is there
 * anything in here", and the names answer "is it the thing I am looking for"
 * without opening it.
 */
export function summariseGroup(
  fields: readonly ActionConfigFieldBase[],
  config: Record<string, unknown>
): { count: number; labels: string[] } {
  const labels: string[] = [];
  for (const field of fields) {
    if (fieldIsSet(field, config)) {
      labels.push(field.label);
    }
  }
  return { count: labels.length, labels };
}
