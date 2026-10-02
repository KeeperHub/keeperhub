/**
 * Alternative credentials on one connection form.
 *
 * Some services take either of two and never both, and the run time silently
 * prefers one. A plugin marks each alternative with `exclusiveGroup`; this
 * decides which is in use and which the form holds shut. Kept pure so the add
 * and edit forms share one rule rather than a copy each.
 */

export type ExclusiveField = {
  id: string;
  configKey: string;
  exclusiveGroup?: string;
  exclusiveGroupLabel?: string;
};

export type ExclusiveGroup = {
  id: string;
  label: string;
  /** The field that opens the group, so the form knows where to put its heading. */
  firstFieldId: string;
  configKeys: string[];
  filled: boolean;
};

export type ExclusiveGroupState = {
  groups: ExclusiveGroup[];
  /**
   * The group the run time will actually use: the only one filled in, or the
   * first filled one when somebody has filled in more than one.
   */
  activeGroupId?: string;
  /** True when more than one is filled, which the form should say out loud. */
  ambiguous: boolean;
};

function hasValue(value: unknown): boolean {
  return typeof value === "string"
    ? value.trim().length > 0
    : value !== undefined && value !== null && value !== false;
}

/**
 * Resolve which alternative is in use.
 *
 * Every answer comes from values the caller can see. A form editing a stored
 * credential is never sent its value, so it substitutes a placeholder for the
 * keys the server says are set - see `storedSecretKeys` - rather than asking
 * this to guess from an absence.
 */
export function resolveExclusiveGroups(
  fields: readonly ExclusiveField[],
  config: Record<string, unknown>
): ExclusiveGroupState {
  const groups: ExclusiveGroup[] = [];

  for (const field of fields) {
    if (!field.exclusiveGroup) {
      continue;
    }
    const existing = groups.find((group) => group.id === field.exclusiveGroup);
    if (existing) {
      existing.configKeys.push(field.configKey);
      continue;
    }
    groups.push({
      id: field.exclusiveGroup,
      label: field.exclusiveGroupLabel ?? field.exclusiveGroup,
      firstFieldId: field.id,
      configKeys: [field.configKey],
      filled: false,
    });
  }

  for (const group of groups) {
    group.filled = group.configKeys.some((key) => hasValue(config[key]));
  }

  const filled = groups.filter((group) => group.filled);
  return {
    groups,
    // Field order is the precedence the run time applies, so the first filled
    // group is the one that wins. Saying which is the point of reporting it.
    activeGroupId: filled[0]?.id,
    ambiguous: filled.length > 1,
  };
}

/**
 * Whether this field should be held shut: another alternative is in use, and
 * filling this one in as well would do nothing.
 *
 * Nothing is held shut while more than one group is filled. That state is
 * somebody's existing connection, or a form somebody is halfway through
 * rearranging, and locking fields there would leave them unable to empty the
 * one being ignored.
 */
export function isFieldLocked(
  field: ExclusiveField,
  state: ExclusiveGroupState
): boolean {
  if (!(field.exclusiveGroup && state.activeGroupId) || state.ambiguous) {
    return false;
  }
  return field.exclusiveGroup !== state.activeGroupId;
}
