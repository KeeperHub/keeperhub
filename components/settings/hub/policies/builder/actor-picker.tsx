"use client";

import { Checkbox } from "@/components/ui/checkbox";
import {
  ActorScope,
  memberOptions,
  POLICY_ROLES,
  ROLE_LABEL,
} from "@/lib/policy/ui";
import { usePolicyCatalog } from "../policy-context";
import { FieldLabel } from "./field-label";
import { SearchableSelect } from "./searchable-select";

const SCOPE_OPTIONS = [
  {
    value: ActorScope.ANYONE,
    label: "Anyone",
    hint: "Every member, and every API key and agent acting for the organization",
  },
  {
    value: ActorScope.ROLES,
    label: "People holding a role",
    hint: "Owner, admins or members",
  },
  {
    value: ActorScope.PEOPLE,
    label: "One named person",
    hint: "A single member",
  },
];

/**
 * Who a rule applies to.
 *
 * Most rules about the organization are about people rather than things: "only
 * an owner may issue an API key" is a rule about the actor, not about the key.
 */
export function ActorPicker({
  index,
  scope,
  roles,
  memberIds,
  onScopeChange,
  onRolesChange,
  onMemberIdsChange,
}: {
  index: number;
  scope: ActorScope;
  roles: readonly string[];
  memberIds: readonly string[];
  onScopeChange: (next: ActorScope) => void;
  onRolesChange: (next: string[]) => void;
  onMemberIdsChange: (next: string[]) => void;
}): React.ReactElement {
  const { catalog } = usePolicyCatalog();

  // Changing the scope clears the other side, so a rule can never carry two
  // contradictory answers to the same question.
  const changeScope = (next: string): void => {
    onScopeChange(next as ActorScope);
    if (next === ActorScope.ANYONE) {
      onRolesChange([]);
      onMemberIdsChange([]);
      return;
    }
    if (next === ActorScope.ROLES) {
      onMemberIdsChange([]);
      return;
    }
    onRolesChange([]);
  };

  const toggleRole = (role: string): void => {
    onRolesChange(
      roles.includes(role)
        ? roles.filter((value) => value !== role)
        : [...roles, role]
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <FieldLabel
          hint="Who the rule covers. A rule that names nobody in particular applies to everyone, including API keys and agents. To cover two different groups, write a second rule."
          htmlFor={`actor-scope-${index}`}
        >
          Who this applies to
        </FieldLabel>
        <SearchableSelect
          id={`actor-scope-${index}`}
          onChange={changeScope}
          options={SCOPE_OPTIONS}
          value={scope}
        />
      </div>

      {scope === ActorScope.ROLES && (
        <div className="flex flex-wrap gap-4">
          {POLICY_ROLES.map((role) => (
            <button
              aria-pressed={roles.includes(role)}
              className="flex items-center gap-2 rounded-sm px-1 py-1 text-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              key={role}
              onClick={() => toggleRole(role)}
              type="button"
            >
              <Checkbox
                aria-hidden
                checked={roles.includes(role)}
                className="pointer-events-none"
                tabIndex={-1}
              />
              {ROLE_LABEL[role] ?? role}
            </button>
          ))}
          {roles.length === 0 && (
            <p className="text-muted-foreground text-xs">
              No role is ticked, so this rule currently applies to everyone.
            </p>
          )}
        </div>
      )}

      {scope === ActorScope.PEOPLE && (
        <SearchableSelect
          id={`actor-${index}`}
          onChange={(next) => onMemberIdsChange(next ? [next] : [])}
          options={memberOptions(catalog.members)}
          placeholder="Choose a member"
          searchPlaceholder="Search members"
          value={memberIds[0] ?? ""}
        />
      )}
    </div>
  );
}
