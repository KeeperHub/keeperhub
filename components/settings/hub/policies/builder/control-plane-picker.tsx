"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { Capability } from "@/lib/policy";
import {
  capabilitiesForTarget,
  capabilityLabel,
  hasNamedResource,
  onlyCreates,
  STATEMENT_TARGET_HINT,
  STATEMENT_TARGET_LABEL,
  STATEMENT_TARGET_SINGULAR,
  StatementTarget,
  supportsProjectScope,
} from "@/lib/policy/catalog";
import { resourceOptions } from "@/lib/policy/ui";
import { usePolicyCatalog } from "../policy-context";
import { FieldLabel } from "./field-label";
import { SearchableSelect } from "./searchable-select";

/**
 * What may be done to a resource the organization owns.
 *
 * The control plane is not an extra: a counterparty allowlist means nothing if
 * any member can add a counterparty, and any rule means nothing if whoever it
 * constrains can edit the policy.
 */
export function ControlPlanePicker({
  target,
  index,
  capabilities,
  resourceId,
  projectIds,
  tagIds,
  onCapabilitiesChange,
  onResourceIdChange,
  onProjectIdsChange,
  onTagIdsChange,
}: {
  target: StatementTarget;
  index: number;
  capabilities: readonly string[];
  resourceId: string;
  projectIds: readonly string[];
  tagIds: readonly string[];
  onCapabilitiesChange: (next: string[]) => void;
  onResourceIdChange: (next: string) => void;
  onProjectIdsChange: (next: string[]) => void;
  onTagIdsChange: (next: string[]) => void;
}): React.ReactElement {
  const { catalog } = usePolicyCatalog();
  const available = capabilitiesForTarget(target);
  const hint = STATEMENT_TARGET_HINT[target];
  const creationOnly = onlyCreates(capabilities);
  const options = resourceOptions(target, catalog);
  const namesResource = hasNamedResource(target);
  const scopedByProject = supportsProjectScope(target);

  const toggleIn = (
    current: readonly string[],
    id: string,
    apply: (next: string[]) => void
  ): void => {
    apply(
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id]
    );
  };

  const toggle = (capability: Capability): void => {
    onCapabilitiesChange(
      capabilities.includes(capability)
        ? capabilities.filter((c) => c !== capability)
        : [...capabilities, capability]
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}

      {target === StatementTarget.POLICY && (
        <Alert>
          <AlertDescription>
            An owner can always edit policy, whatever this rule says. Without
            that one exception a bad policy could lock the organization out
            permanently.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1.5">
        <FieldLabel hint="Each box is a separate thing that can be done to this kind of resource. A rule with no box ticked matches nothing.">
          What this rule covers
        </FieldLabel>
        <div className="flex flex-col gap-1">
          {available.map((capability) => (
            <button
              aria-pressed={capabilities.includes(capability)}
              className="flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left text-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              key={capability}
              onClick={() => toggle(capability)}
              type="button"
            >
              <Checkbox
                aria-hidden
                checked={capabilities.includes(capability)}
                className="pointer-events-none"
                tabIndex={-1}
              />
              <span>{capabilityLabel(capability)}</span>
              <span className="font-mono text-muted-foreground">
                {capability}
              </span>
            </button>
          ))}
        </div>
      </div>

      {scopedByProject && (
        <>
          {catalog.projects.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <FieldLabel hint="Limits the rule to workflows in these projects. This is the only scope a creation can carry, because the thing being created has no id yet.">
                Only in these projects
              </FieldLabel>
              <div className="flex flex-col gap-1">
                {catalog.projects.map((project) => (
                  <div
                    className="flex items-center gap-2 text-xs"
                    key={project.id}
                  >
                    <Checkbox
                      checked={projectIds.includes(project.id)}
                      id={`project-${index}-${project.id}`}
                      onCheckedChange={() =>
                        toggleIn(projectIds, project.id, onProjectIdsChange)
                      }
                    />
                    <label htmlFor={`project-${index}-${project.id}`}>
                      {project.name}
                    </label>
                  </div>
                ))}
              </div>
              <p className="text-muted-foreground text-xs">
                Leave every box clear to cover every project.
              </p>
            </div>
          )}

          {catalog.tags.length > 0 && !creationOnly && (
            <div className="flex flex-col gap-1.5">
              <FieldLabel hint="Limits the rule to workflows carrying these tags. A workflow being created carries none yet, so this does not apply to creation.">
                Only with these tags
              </FieldLabel>
              <div className="flex flex-col gap-1">
                {catalog.tags.map((tag) => (
                  <div className="flex items-center gap-2 text-xs" key={tag.id}>
                    <Checkbox
                      checked={tagIds.includes(tag.id)}
                      id={`tag-${index}-${tag.id}`}
                      onCheckedChange={() =>
                        toggleIn(tagIds, tag.id, onTagIdsChange)
                      }
                    />
                    <label htmlFor={`tag-${index}-${tag.id}`}>{tag.name}</label>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {namesResource && creationOnly && (
        <p className="text-muted-foreground text-xs">
          These actions create something, so there is no single resource to
          name.
          {scopedByProject
            ? " Narrow the rule by project above."
            : " The rule covers every one of them."}
        </p>
      )}

      {namesResource && !creationOnly && (
        <div className="flex flex-col gap-1.5">
          <FieldLabel
            hint="A rule normally covers every one of them. Narrowing it to a single one leaves all the others governed by whatever else this policy says, or unmanaged if nothing does."
            htmlFor={`resource-id-${index}`}
          >
            Limit to one {STATEMENT_TARGET_SINGULAR[target] ?? "resource"}{" "}
            (optional)
          </FieldLabel>
          {options.length > 0 ? (
            <SearchableSelect
              id={`resource-id-${index}`}
              onChange={onResourceIdChange}
              options={options}
              placeholder="Every one of them"
              searchPlaceholder={`Search ${STATEMENT_TARGET_LABEL[target].toLowerCase()}`}
              value={resourceId}
            />
          ) : (
            <Input
              id={`resource-id-${index}`}
              onChange={(e) => onResourceIdChange(e.target.value)}
              placeholder="Every one of them"
              value={resourceId}
            />
          )}
          <p className="text-muted-foreground text-xs">
            Leave it empty and the rule covers every{" "}
            {STATEMENT_TARGET_SINGULAR[target] ?? "resource"} in the
            organization.
          </p>
        </div>
      )}
    </div>
  );
}
