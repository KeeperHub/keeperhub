"use client";

import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import type { OverlayComponentProps } from "@/components/overlays/types";

type MarketplaceListingOverlayProps = OverlayComponentProps<{
  displayName: string;
  description: string | null;
  organizationName: string | null;
  tags: readonly string[];
  callCount: number;
  priceLabel: string;
  chainLabel: string | null;
  inputSchema: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
}>;

type InputField = {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
};

function formatCallCount(count: number): string {
  return count.toLocaleString("en-US");
}

// Walk a JSON Schema's `properties` object into a flat list ready for
// rendering. Mirrors the structure produced by SchemaBuilder in the listing
// overlay (see fieldsToJsonSchema). Nested object/array shapes are shown via
// their top-level `type` only — the modal is a summary, not a full schema
// browser.
function readInputFields(schema: Record<string, unknown> | null): InputField[] {
  if (!schema) {
    return [];
  }
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties) {
    return [];
  }
  const requiredNames = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  const fields: InputField[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    const type = typeof prop.type === "string" ? prop.type : "any";
    const description =
      typeof prop.description === "string" ? prop.description : null;
    fields.push({
      name,
      type,
      required: requiredNames.includes(name),
      description,
    });
  }
  // Required fields lead so callers see what they MUST provide before the
  // optional knobs. Stable sort within each group preserves declaration order.
  fields.sort((a, b) => {
    if (a.required === b.required) {
      return 0;
    }
    return a.required ? -1 : 1;
  });
  return fields;
}

function readOutputField(
  mapping: Record<string, unknown> | null
): string | null {
  if (!mapping || typeof mapping.field !== "string") {
    return null;
  }
  return mapping.field;
}

export function MarketplaceListingOverlay({
  overlayId,
  displayName,
  description,
  organizationName,
  tags,
  callCount,
  priceLabel,
  chainLabel,
  inputSchema,
  outputMapping,
}: MarketplaceListingOverlayProps): React.ReactElement {
  const { closeAll } = useOverlay();
  const inputs = readInputFields(inputSchema);
  const outputField = readOutputField(outputMapping);

  return (
    <Overlay
      actions={[{ label: "Close", variant: "outline", onClick: closeAll }]}
      overlayId={overlayId}
      title={displayName}
    >
      <div className="space-y-5">
        <dl className="grid grid-cols-4 gap-3 rounded-md border border-border/40 bg-muted/30 p-3">
          <div>
            <dt className="text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
              Owner
            </dt>
            <dd className="mt-1 truncate font-semibold text-foreground text-sm">
              {organizationName ?? "Anonymous"}
            </dd>
          </div>
          <div>
            <dt className="text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
              Calls
            </dt>
            <dd className="mt-1 font-semibold text-foreground text-sm tabular-nums">
              {formatCallCount(callCount)}
            </dd>
          </div>
          <div>
            <dt className="text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
              Price
            </dt>
            <dd className="mt-1 font-mono font-semibold text-foreground text-sm tabular-nums">
              {priceLabel || "Not set"}
            </dd>
          </div>
          <div>
            <dt className="text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
              Chain
            </dt>
            <dd className="mt-1 font-semibold text-foreground text-sm">
              {chainLabel ?? "Not set"}
            </dd>
          </div>
        </dl>

        {tags.length > 0 && (
          <div>
            <h3 className="text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
              Tags
            </h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground text-xs"
                  key={tag}
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}

        <div>
          <h3 className="text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
            Description
          </h3>
          {description ? (
            <p className="mt-2 whitespace-pre-line text-foreground text-sm leading-relaxed">
              {description}
            </p>
          ) : (
            <p className="mt-2 text-muted-foreground text-sm italic">
              The author hasn't added a description yet.
            </p>
          )}
        </div>

        <div>
          <h3 className="text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
            Input
          </h3>
          {inputs.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {inputs.map((field) => (
                <li
                  className="rounded-md border border-border/40 bg-muted/20 p-2.5"
                  key={field.name}
                >
                  <div className="flex items-center gap-2">
                    <code className="font-mono font-semibold text-foreground text-sm">
                      {field.name}
                    </code>
                    <span className="text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
                      {field.type}
                    </span>
                    {field.required && (
                      <span className="rounded bg-[var(--color-bg-accent)] px-1.5 py-0.5 font-medium text-[0.625rem] text-[var(--color-text-accent)] uppercase">
                        Required
                      </span>
                    )}
                  </div>
                  {field.description && (
                    <p className="mt-1 text-muted-foreground text-xs">
                      {field.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-muted-foreground text-sm italic">
              No inputs required.
            </p>
          )}
        </div>

        <div>
          <h3 className="text-[0.6875rem] text-muted-foreground uppercase tracking-wide">
            Output
          </h3>
          {outputField ? (
            <ul className="mt-2 space-y-2">
              <li className="rounded-md border border-border/40 bg-muted/20 p-2.5">
                <div className="flex items-center gap-2">
                  <code className="font-mono font-semibold text-foreground text-sm">
                    {outputField}
                  </code>
                </div>
                <p className="mt-1 text-muted-foreground text-xs">
                  Field returned to the caller.
                </p>
              </li>
            </ul>
          ) : (
            <p className="mt-2 text-muted-foreground text-sm italic">
              Output mapping not configured.
            </p>
          )}
        </div>
      </div>
    </Overlay>
  );
}
