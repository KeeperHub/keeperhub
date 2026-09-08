"use client";

export function RecoveryEmailCard({
  email,
}: {
  email: string;
}): React.ReactElement {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-sm">Recovery email</span>
      </div>
      <div className="space-y-1">
        <p className="text-sm">{email}</p>
        <p className="text-muted-foreground text-xs">
          Used for verification when exporting the private key. Contact support
          to change this address.
        </p>
      </div>
    </section>
  );
}
