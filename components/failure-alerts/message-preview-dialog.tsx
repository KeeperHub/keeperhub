"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { MessagePreview } from "@/lib/notifications/failure-alerts/view-types";
import { fetchView } from "./api";

type Sample = MessagePreview["sample"];

const SAMPLE_LABEL: Record<Sample, string> = {
  alert: "A workflow keeps failing",
  missed: "A scheduled workflow did not run",
  paused: "A workflow was paused at its limit",
  recovery: "It is running again",
};

/** The real message text for an example workflow, as email, chat and PagerDuty show it. */
export function MessagePreviewDialog({
  organizationId,
}: {
  organizationId: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState<Sample>("alert");
  const [preview, setPreview] = useState<MessagePreview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    let active = true;
    setPreview(null);
    setFailed(false);
    fetchView<MessagePreview>(
      `/api/organizations/${encodeURIComponent(organizationId)}/failure-alerts/preview?sample=${sample}`
    )
      .then((next) => active && setPreview(next))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [open, organizationId, sample]);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm" type="button" variant="outline">
          See what people get
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>What people get</DialogTitle>
          <DialogDescription>
            An example, made by the same code as real alerts. Every method gets
            the same words; only the layout differs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="failure-preview-sample">Message</Label>
          <Select
            onValueChange={(value) => setSample(value as Sample)}
            value={sample}
          >
            <SelectTrigger className="w-full" id="failure-preview-sample">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SAMPLE_LABEL) as Sample[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {SAMPLE_LABEL[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {failed && (
          <Notice role="alert" tone="danger">
            Could not load the preview. Close this and try again.
          </Notice>
        )}
        {!(preview || failed) && (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <Loader2 className="size-3.5 animate-spin" />
            Loading
          </div>
        )}
        {preview && (
          <Tabs defaultValue="email">
            <TabsList className="w-full">
              <TabsTrigger value="email">Email</TabsTrigger>
              <TabsTrigger value="chat">Chat</TabsTrigger>
              <TabsTrigger value="pagerduty">PagerDuty</TabsTrigger>
            </TabsList>
            <TabsContent className="space-y-2" value="email">
              <p className="break-words text-sm">
                <span className="text-muted-foreground">Subject: </span>
                {preview.subject}
              </p>
              <iframe
                className="h-96 w-full rounded-md border bg-white"
                sandbox=""
                srcDoc={preview.html}
                title="Email preview"
              />
            </TabsContent>
            <TabsContent className="space-y-2" value="chat">
              <p className="text-muted-foreground text-xs">
                Slack, Discord and Telegram get this text.
              </p>
              <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs">
                {preview.chat}
              </pre>
            </TabsContent>
            <TabsContent className="space-y-2" value="pagerduty">
              <p className="text-muted-foreground text-xs">
                The incident title. The same facts are attached as details, and
                the incident resolves itself when the workflow runs again.
              </p>
              <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs">
                {preview.pagerDutySummary}
              </pre>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
