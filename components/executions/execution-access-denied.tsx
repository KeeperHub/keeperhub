import Link from "next/link";
import { Button } from "@/components/ui/button";

export function ExecutionAccessDenied(): React.ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <h1 className="font-semibold text-xl">Access denied</h1>
        <p className="text-muted-foreground text-sm">
          You are signed in, but this execution belongs to another organization
          or is not shared publicly.
        </p>
        <Button asChild variant="outline">
          <Link href="/hub">Back to Hub</Link>
        </Button>
      </div>
    </main>
  );
}
