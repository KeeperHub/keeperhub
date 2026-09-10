"use client";

import { ArrowRight, Check, Loader2, LockKeyhole, Radio } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { useAuthPrompt } from "@/components/auth/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api-client";
import { useSession } from "@/lib/auth-client";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { pythDemoEvidence } from "@/lib/pyth/demo-evidence";
import { createPythStarterWorkflow } from "@/lib/pyth/starter-workflow";
import styles from "./showcase.module.css";

export function CreateTrigger() {
  const router = useRouter();
  const { openAuthPrompt } = useAuthPrompt();
  const { data: session, isPending } = useSession();
  const [direction, setDirection] = useState("above");
  const [threshold, setThreshold] = useState("");
  const [rearm, setRearm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = Boolean(session?.user) && !isAnonymousUser(session?.user);

  async function createWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !signedIn) {
      return;
    }
    setError(null);
    try {
      const workflow = createPythStarterWorkflow({
        feedId: pythDemoEvidence.feedId,
        direction,
        threshold,
        rearmThreshold: rearm,
        maxAgeSeconds: 30,
      });
      setSaving(true);
      const created = await api.workflow.create(workflow);
      router.push(`/workflows/${created.id}`);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not create your workflow. Please try again."
      );
      setSaving(false);
    }
  }

  return (
    <form className={styles.builder} onSubmit={createWorkflow}>
      <div className={styles.builderHeader}>
        <div className={styles.iconTile}>
          <Radio size={21} />
        </div>
        <div>
          <h3>Your first price trigger</h3>
          <p>A native workflow, ready for your next action.</p>
        </div>
      </div>
      <div className={styles.feedSelection}>
        <span>PRICE FEED</span>
        <strong>
          Ethereum <span>ETH / USD</span>
        </strong>
        <Check size={16} />
      </div>
      <div className={styles.builderField}>
        <Label htmlFor="launch-direction">Trigger direction</Label>
        <Select
          disabled={saving}
          onValueChange={setDirection}
          value={direction}
        >
          <SelectTrigger id="launch-direction">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="above">Price reaches or goes above</SelectItem>
            <SelectItem value="below">Price reaches or goes below</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className={styles.fieldPair}>
        <div className={styles.builderField}>
          <Label htmlFor="launch-threshold">Threshold · USD</Label>
          <Input
            disabled={saving}
            id="launch-threshold"
            inputMode="decimal"
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="Enter your target"
            required
            value={threshold}
          />
        </div>
        <div className={styles.builderField}>
          <Label htmlFor="launch-rearm">Rearm price · USD</Label>
          <Input
            disabled={saving}
            id="launch-rearm"
            inputMode="decimal"
            onChange={(e) => setRearm(e.target.value)}
            placeholder={
              direction === "above"
                ? "Below the threshold"
                : "Above the threshold"
            }
            required
            value={rearm}
          />
        </div>
      </div>
      <p className={styles.builderHint}>
        The price must return to the rearm level before another crossing can
        fire. You can choose another feed and adjust signal age in the editor.
      </p>
      {error && (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      )}
      {signedIn ? (
        <Button
          className={styles.primaryButton}
          disabled={saving}
          type="submit"
        >
          {saving ? <Loader2 className={styles.spin} size={17} /> : null}
          {saving ? "Creating your workflow…" : "Create & open in KeeperHub"}
          <ArrowRight size={17} />
        </Button>
      ) : null}
      {!signedIn && isPending && (
        <Button className={styles.primaryButton} disabled>
          Checking your session…
        </Button>
      )}
      {!(signedIn || isPending) && (
        <Button
          className={styles.primaryButton}
          onClick={() =>
            openAuthPrompt({
              action: "build a Pyth trigger",
              redirectTo: "/pyth#build",
            })
          }
          type="button"
        >
          Sign in to build your trigger
          <ArrowRight size={17} />
        </Button>
      )}
      <p className={styles.builderFootnote}>
        <LockKeyhole size={13} /> Created disabled. Review and enable it in the
        editor.
      </p>
    </form>
  );
}
