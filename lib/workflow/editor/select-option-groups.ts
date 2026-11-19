import type { SelectOption } from "@/plugins/registry";

export type SelectOptionGroup = { label: string; options: SelectOption[] };

// Consecutive options with the same group share one section header.
export function groupSelectOptions(
  options: readonly SelectOption[]
): SelectOptionGroup[] {
  const groups: SelectOptionGroup[] = [];
  for (const option of options) {
    const label = option.group ?? "";
    const last = groups.at(-1);
    if (last && last.label === label) {
      last.options.push(option);
    } else {
      groups.push({ label, options: [option] });
    }
  }
  return groups;
}

// "Text: contains": the option with its group, for messages that stand alone.
export function qualifiedOptionLabel(
  options: readonly SelectOption[],
  value: string
): string | undefined {
  const option = options.find((candidate) => candidate.value === value);
  if (!option) {
    return;
  }
  return option.group ? `${option.group}: ${option.label}` : option.label;
}

// The closed select names the group only where the label repeats
// ("Text: contains" vs "Array: contains"), as Condition's dropdown does.
export function groupedSelectLabel(
  options: readonly SelectOption[],
  value: string
): string | undefined {
  const option = options.find((candidate) => candidate.value === value);
  if (!option) {
    return;
  }
  const repeats = options.some(
    (other) => other !== option && other.label === option.label
  );
  return repeats ? qualifiedOptionLabel(options, value) : option.label;
}
