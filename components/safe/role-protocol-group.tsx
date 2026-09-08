"use client";

import { PROTOCOL_CATALOG } from "@/lib/safe/protocol-registry";
import { type RoleAllowance, RoleAllowanceRow } from "./role-allowance-row";

type Props = {
  protocolSlug: string;
  allowances: RoleAllowance[];
  safeId: string;
  isAdmin: boolean;
  isOwner: boolean;
  onAllowanceRevoked: () => Promise<void>;
  /** Per-allowance edit click; opens the focused per-policy edit modal in
   *  the parent. Pass undefined to hide the pencil. */
  onEditAllowance?: (allowanceId: string) => void;
};

export function RoleProtocolGroup({
  protocolSlug,
  allowances,
  safeId,
  isAdmin,
  isOwner,
  onAllowanceRevoked,
  onEditAllowance,
}: Props): React.ReactElement {
  const catalog =
    PROTOCOL_CATALOG[protocolSlug as keyof typeof PROTOCOL_CATALOG];
  const label = catalog?.label ?? protocolSlug;
  const description = catalog?.description;

  return (
    <div className="space-y-2 rounded border bg-muted/10 p-3">
      <div>
        <div className="font-medium text-sm">{label}</div>
        {description && (
          <div className="text-muted-foreground text-xs">{description}</div>
        )}
      </div>
      {allowances.length > 0 ? (
        <ul className="space-y-1.5">
          {allowances.map((allowance) => (
            <RoleAllowanceRow
              allowance={allowance}
              isAdmin={isAdmin}
              isOwner={isOwner}
              key={allowance.id}
              onEdit={
                onEditAllowance
                  ? () => onEditAllowance(allowance.id)
                  : undefined
              }
              onRevoked={onAllowanceRevoked}
              safeId={safeId}
            />
          ))}
        </ul>
      ) : (
        <div className="text-muted-foreground text-xs">
          No spending limits configured for this protocol.
        </div>
      )}
    </div>
  );
}
