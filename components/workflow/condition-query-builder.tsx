"use client";

import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateBadgeInput } from "@/components/ui/template-badge-input";
import type {
  ConditionGroup,
  ConditionOperator,
  ConditionRule,
} from "@/lib/workflow/nodes/condition/builder-types";
import { isConditionGroup } from "@/lib/workflow/nodes/condition/builder-types";
import {
  createEmptyGroup,
  createEmptyRule,
  isUnaryOperator,
  OPERATOR_GROUPS,
  OPERATOR_METADATA,
  operatorsForCategory,
} from "@/lib/workflow/nodes/condition/builder-utils";
import { cn } from "@/lib/utils";

type ConditionQueryBuilderProps = {
  group: ConditionGroup;
  onChange: (group: ConditionGroup) => void;
  disabled?: boolean;
};

// Operators grouped by value type so the dropdown shows section headers
// (General / Text / Number / Boolean / Array / Object) with their operators
// beneath, making clear which comparisons apply to which kind of value.
const OPERATOR_OPTION_GROUPS = OPERATOR_GROUPS.map((groupMeta) => ({
  label: groupMeta.label,
  operators: operatorsForCategory(groupMeta.category),
}));

function RuleRow({
  rule,
  onChange,
  onRemove,
  disabled,
  canRemove,
}: {
  rule: ConditionRule;
  onChange: (rule: ConditionRule) => void;
  onRemove: () => void;
  disabled?: boolean;
  canRemove: boolean;
}): React.ReactElement {
  const unary = isUnaryOperator(rule.operator);

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1 [&_[contenteditable]]:max-h-9 [&_[contenteditable]]:overflow-x-auto [&_[contenteditable]]:whitespace-nowrap [&_[contenteditable]]:[scrollbar-width:none]">
        <TemplateBadgeInput
          disabled={disabled}
          onChange={(value) => onChange({ ...rule, leftOperand: value })}
          placeholder="Value or @ref"
          value={rule.leftOperand}
        />
      </div>

      <Select
        disabled={disabled}
        onValueChange={(value) =>
          onChange({ ...rule, operator: value as ConditionOperator })
        }
        value={rule.operator}
      >
        <SelectTrigger className="h-9 w-[120px] shrink-0 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-w-[280px]">
          {OPERATOR_OPTION_GROUPS.map((optionGroup) => (
            <SelectGroup key={optionGroup.label}>
              <SelectLabel>{optionGroup.label}</SelectLabel>
              {optionGroup.operators.map((op) => (
                <SelectItem
                  description={OPERATOR_METADATA[op].description}
                  key={op}
                  value={op}
                >
                  {OPERATOR_METADATA[op].label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>

      {!unary && (
        <div className="min-w-0 flex-1 [&_[contenteditable]]:max-h-9 [&_[contenteditable]]:overflow-x-auto [&_[contenteditable]]:whitespace-nowrap [&_[contenteditable]]:[scrollbar-width:none]">
          <TemplateBadgeInput
            disabled={disabled}
            onChange={(value) => onChange({ ...rule, rightOperand: value })}
            placeholder="Value or @ref"
            value={rule.rightOperand}
          />
        </div>
      )}

      {canRemove && (
        <Button
          className="size-6 shrink-0"
          disabled={disabled}
          onClick={onRemove}
          size="icon"
          variant="ghost"
        >
          <X className="size-3" />
        </Button>
      )}
    </div>
  );
}

function GroupBuilder({
  group,
  onChange,
  onRemove,
  disabled,
  isRoot,
}: {
  group: ConditionGroup;
  onChange: (group: ConditionGroup) => void;
  onRemove?: () => void;
  disabled?: boolean;
  isRoot?: boolean;
}): React.ReactElement {
  const updateRule = (
    index: number,
    updated: ConditionRule | ConditionGroup
  ): void => {
    const newRules = [...group.rules];
    newRules[index] = updated;
    onChange({ ...group, rules: newRules });
  };

  const removeRule = (index: number): void => {
    const newRules = group.rules.filter((_, i) => i !== index);
    onChange({
      ...group,
      rules: newRules.length > 0 ? newRules : [createEmptyRule()],
    });
  };

  const addRule = (): void => {
    onChange({ ...group, rules: [...group.rules, createEmptyRule()] });
  };

  const addGroup = (): void => {
    onChange({ ...group, rules: [...group.rules, createEmptyGroup()] });
  };

  const logicToggle = (
    <div className="flex items-center gap-2 py-1">
      <div className="min-w-0 flex-1 [&_[contenteditable]]:max-h-9 [&_[contenteditable]]:overflow-x-auto [&_[contenteditable]]:whitespace-nowrap [&_[contenteditable]]:[scrollbar-width:none]">
        <div className="h-px w-full bg-border" />
      </div>
      <Select
        disabled={disabled}
        onValueChange={(value) =>
          onChange({ ...group, logic: value as "AND" | "OR" })
        }
        value={group.logic}
      >
        <SelectTrigger className="h-6 w-[120px] shrink-0 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="AND">AND</SelectItem>
          <SelectItem value="OR">OR</SelectItem>
        </SelectContent>
      </Select>
      <div className="min-w-0 flex-1 [&_[contenteditable]]:max-h-9 [&_[contenteditable]]:overflow-x-auto [&_[contenteditable]]:whitespace-nowrap [&_[contenteditable]]:[scrollbar-width:none]">
        <div className="h-px w-full bg-border" />
      </div>
      <div className="size-6 shrink-0" />
    </div>
  );

  return (
    <div
      className={cn(
        "space-y-2",
        !isRoot && "ml-3 border-l-2 border-muted pl-3"
      )}
    >
      {!isRoot && onRemove && (
        <div className="flex justify-end">
          <Button
            className="size-7"
            disabled={disabled}
            onClick={onRemove}
            size="icon"
            variant="ghost"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      )}

      {group.rules.map((item, index) => (
        <div key={item.id}>
          {index > 0 && logicToggle}
          {isConditionGroup(item) ? (
            <GroupBuilder
              disabled={disabled}
              group={item}
              onChange={(updated) => updateRule(index, updated)}
              onRemove={() => removeRule(index)}
            />
          ) : (
            <RuleRow
              canRemove={group.rules.length > 1}
              disabled={disabled}
              onChange={(updated) => updateRule(index, updated)}
              onRemove={() => removeRule(index)}
              rule={item}
            />
          )}
        </div>
      ))}

      <div className="flex gap-2 pt-1">
        <Button
          className="h-7 text-xs"
          disabled={disabled}
          onClick={addRule}
          size="sm"
          variant="outline"
        >
          <Plus className="mr-1 size-3" />
          Condition
        </Button>
        <Button
          className="h-7 text-xs"
          disabled={disabled}
          onClick={addGroup}
          size="sm"
          variant="outline"
        >
          <Plus className="mr-1 size-3" />
          Group
        </Button>
      </div>
    </div>
  );
}

export function ConditionQueryBuilder({
  group,
  onChange,
  disabled,
}: ConditionQueryBuilderProps): React.ReactElement {
  return (
    <GroupBuilder
      disabled={disabled}
      group={group}
      isRoot
      onChange={onChange}
    />
  );
}
