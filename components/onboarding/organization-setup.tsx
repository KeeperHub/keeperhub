"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function OrganizationSetup() {
  const router = useRouter();
  const [mode, setMode] = useState<"choice" | "create" | "join">("choice");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Auto-generate slug from name (unless user has manually edited it)
  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugManuallyEdited) {
      setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    }
  };

  const handleSlugChange = (value: string) => {
    setSlug(value);
    setSlugManuallyEdited(true);
  };

  const handleCreate = async () => {
    setLoading(true);
    setError("");

    try {
      const { data, error: createError } = await authClient.organization.create(
        {
          name,
          slug,
        }
      );

      if (createError) {
        setError(createError.message || "Failed to create organization");
        return;
      }

      // Set as active organization - data contains the org directly
      await authClient.organization.setActive({
        organizationId: (data as { id: string } | null)?.id ?? "",
      });

      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async () => {
    setLoading(true);
    setError("");

    try {
      // Accept invitation directly - getInvitation might not be needed
      const { error: acceptError } =
        await authClient.organization.acceptInvitation({
          invitationId: inviteCode,
        });

      if (acceptError) {
        setError(acceptError.message || "Invalid or expired invitation code");
        return;
      }

      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  if (mode === "choice") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-[400px]">
          <CardHeader>
            <CardTitle>Welcome!</CardTitle>
            <CardDescription>
              To continue, create a new organization or join an existing one.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              className="w-full"
              onClick={() => setMode("create")}
              size="lg"
            >
              Create Organization
            </Button>
            <Button
              className="w-full"
              onClick={() => setMode("join")}
              size="lg"
              variant="outline"
            >
              Join Organization
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (mode === "create") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="w-[400px]">
          <CardHeader>
            <CardTitle>Create Organization</CardTitle>
            <CardDescription>
              Set up a new organization for your team.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Organization Name</Label>
              <Input
                disabled={loading}
                id="name"
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Acme Inc."
                value={name}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">Slug (URL identifier)</Label>
              <Input
                disabled={loading}
                id="slug"
                onChange={(e) => handleSlugChange(e.target.value)}
                placeholder="acme-inc"
                value={slug}
              />
            </div>
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={loading}
                onClick={() => setMode("choice")}
                variant="outline"
              >
                Back
              </Button>
              <Button
                className="flex-1"
                disabled={loading || !name || !slug}
                onClick={handleCreate}
              >
                {loading ? "Creating..." : "Create"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // mode === "join"
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-[400px]">
        <CardHeader>
          <CardTitle>Join Organization</CardTitle>
          <CardDescription>
            Enter the invitation code you received.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="code">Invitation Code</Label>
            <Input
              disabled={loading}
              id="code"
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="abc123xyz"
              value={inviteCode}
            />
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={loading}
              onClick={() => setMode("choice")}
              variant="outline"
            >
              Back
            </Button>
            <Button
              className="flex-1"
              disabled={loading || !inviteCode}
              onClick={handleJoin}
            >
              {loading ? "Joining..." : "Join"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
